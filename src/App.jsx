import React, { useEffect, useMemo, useState } from "react";
import { createClient } from "@supabase/supabase-js";

/* --- Supabase client --- */
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: true, autoRefreshToken: true },
});

/* --- Helpers --- */
const formatINRnoDecimals = (val) =>
  Number(val ?? 0).toLocaleString("en-IN", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });

// Build next quote ref like APP/H001, APP/H002...
const buildNextRef = async () => {
  const { data } = await supabase
    .from("quotes")
    .select("ref")
    .order("created_at", { ascending: false })
    .limit(1);
  const last = data?.[0]?.ref || "";
  const num = parseInt(last.replace(/[^0-9]/g, "") || "0", 10) + 1;
  const padded = String(num).padStart(3, "0");
  return `APP/H${padded}`;
};

/* --- App --- */
export default function App() {
  // catalog data
  const [items, setItems] = useState([]);
  const [categories, setCategories] = useState([]);
  const [category, setCategory] = useState("All");

  // ui / status
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");

  // top-right menu
  const [menuOpen, setMenuOpen] = useState(false);

  // auth
  const [session, setSession] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loginEmail, setLoginEmail] = useState("");
  const [showLogin, setShowLogin] = useState(false);

  // staff quick view (PIN 2525)
  const [staffMode, setStaffMode] = useState(false);

  // quotation access (PIN 9990)
  const [quoteMode, setQuoteMode] = useState(false);

  // search
  const [search, setSearch] = useState("");

  // cart for quotation
  const [cart, setCart] = useState({}); // id -> {qty, snap:{name,specs,mrp,sell_price,cost_price,category,image_url}}
  const cartCount = useMemo(
    () => Object.values(cart).reduce((n, r) => n + (r.qty || 0), 0),
    [cart]
  );

  // quote editor state (navigation-less "page")
  const [editingQuote, setEditingQuote] = useState(null); // {ref, customer_name, phone, subject, rows:[{...}]}

  // saved quotes list
  const [savedQuotes, setSavedQuotes] = useState([]);
  const loadSavedQuotes = async () => {
    const { data, error } = await supabase
      .from("quotes")
      .select("id, ref, customer_name, created_at, grand_total")
      .order("created_at", { ascending: false })
      .limit(50);
    if (!error) setSavedQuotes(data || []);
  };

  /* ---------- auth ---------- */
  useEffect(() => {
    const init = async () => {
      const { data } = await supabase.auth.getSession();
      setSession(data.session ?? null);
      if (data.session?.user?.id) {
        const { data: prof } = await supabase
          .from("profiles")
          .select("is_admin")
          .eq("user_id", data.session.user.id)
          .maybeSingle();
        setIsAdmin(!!prof?.is_admin);
      } else {
        setIsAdmin(false);
      }
    };
    init();

    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s);
      if (s?.user?.id) {
        supabase
          .from("profiles")
          .select("is_admin")
          .eq("user_id", s.user.id)
          .maybeSingle()
          .then(({ data }) => setIsAdmin(!!data?.is_admin));
      } else {
        setIsAdmin(false);
      }
      setShowLogin(false);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const sendLoginLink = async () => {
    if (!loginEmail) return alert("Enter email first.");
    const { error } = await supabase.auth.signInWithOtp({
      email: loginEmail,
      options: { emailRedirectTo: window.location.origin },
    });
    if (error) alert(error.message);
    else alert("Login link sent. Check your email.");
  };
  const signOut = async () => {
    await supabase.auth.signOut();
    setIsAdmin(false);
  };

  /* ---------- load data ---------- */
  const loadMachines = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("machines")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) setMsg("Supabase error: " + error.message);
    else setItems(data || []);
    setLoading(false);
  };

  const loadCategories = async () => {
    const { data, error } = await supabase
      .from("categories")
      .select("name")
      .order("name", { ascending: true });
    if (!error) setCategories((data || []).map((r) => r.name));
  };

  useEffect(() => {
    loadMachines();
    loadCategories();
  }, []);

  /* ---------- filters ---------- */
  const filtered = useMemo(() => {
    let arr = items;
    if (category !== "All") {
      arr = arr.filter(
        (m) => (m.category || "").toLowerCase() === category.toLowerCase()
      );
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      arr = arr.filter(
        (m) =>
          (m.name || "").toLowerCase().includes(q) ||
          (m.specs || "").toLowerCase().includes(q) ||
          (m.category || "").toLowerCase().includes(q)
      );
    }
    return arr;
  }, [items, category, search]);

  /* ---------- admin: add category ---------- */
  const onAddCategory = async () => {
    const name = (prompt("New category name:") || "").trim();
    if (!name) return;

    const { error } = await supabase.from("categories").insert({ name });
    if (error) {
      alert(error.message);
      return;
    }
    await loadCategories();
    setCategory("All");
    alert("Category added ✅");
  };

  /* ---------- admin: add product ---------- */
  const [form, setForm] = useState({
    name: "",
    category: "",
    mrp: "",
    sell_price: "",
    cost_price: "",
    specs: "",
    imageFile: null,
  });
  const [saving, setSaving] = useState(false);

  const onChange = (e) => {
    const { name, value, files } = e.target;
    if (files) setForm((f) => ({ ...f, imageFile: files[0] || null }));
    else setForm((f) => ({ ...f, [name]: value }));
  };

  const onSave = async (e) => {
    e.preventDefault();
    if (!isAdmin) return alert("Admins only.");
    if (!form.name || !form.category || !form.mrp || !form.imageFile) {
      return alert("Name, Category, MRP and Image are required.");
    }

    setSaving(true);
    try {
      const ext = form.imageFile.name.split(".").pop().toLowerCase();
      const safeBase = form.name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .slice(0, 40);
      const filePath = `products/${Date.now()}-${safeBase}.${ext}`;

      const { error: upErr } = await supabase.storage
        .from("images")
        .upload(filePath, form.imageFile, {
          cacheControl: "3600",
          contentType: form.imageFile.type || "image/jpeg",
          upsert: true,
        });
      if (upErr) throw new Error("UPLOAD: " + upErr.message);

      const { data: urlData, error: urlErr } = supabase.storage
        .from("images")
        .getPublicUrl(filePath);
      if (urlErr) throw new Error("URL: " + urlErr.message);
      const image_url = urlData.publicUrl;

      const payload = {
        name: form.name,
        category: form.category,
        mrp: Number(form.mrp),
        sell_price: form.sell_price ? Number(form.sell_price) : null,
        cost_price: form.cost_price ? Number(form.cost_price) : null,
        specs: form.specs || "",
        image_url,
      };
      const { error: insErr } = await supabase.from("machines").insert(payload);
      if (insErr) throw new Error("INSERT: " + insErr.message);

      setForm({
        name: "",
        category: "",
        mrp: "",
        sell_price: "",
        cost_price: "",
        specs: "",
        imageFile: null,
      });
      await loadMachines();
      alert("Product added ✅");
    } catch (err) {
      console.error(err);
      alert("Failed to add product: " + err.message);
    } finally {
      setSaving(false);
    }
  };

  /* ---------- menu actions ---------- */
  const toggleStaffLogin = () => {
    if (staffMode) return setStaffMode(false);
    const pin = prompt("Enter staff PIN:");
    if ((pin || "").trim() === "2525") setStaffMode(true);
    else alert("Wrong PIN");
  };

  const toggleQuoteLogin = async () => {
    if (quoteMode) {
      setQuoteMode(false);
      setCart({});
      setEditingQuote(null);
      return;
    }
    const pin = prompt("Enter quotation PIN:");
    if ((pin || "").trim() === "9990") {
      setQuoteMode(true);
      loadSavedQuotes();
    } else {
      alert("Wrong PIN");
    }
  };

  /* ---------- cart helpers ---------- */
  const addQty = (m, delta) => {
    setCart((prev) => {
      const cur = prev[m.id] || {
        qty: 0,
        snap: {
          name: m.name,
          specs: m.specs,
          mrp: m.mrp,
          sell_price: m.sell_price,
          cost_price: m.cost_price,
          category: m.category,
          image_url: m.image_url,
        },
      };
      const nextQty = Math.max(0, cur.qty + delta);
      const next = { ...prev };
      if (nextQty === 0) delete next[m.id];
      else next[m.id] = { ...cur, qty: nextQty };
      return next;
    });
  };

  const openQuoteEditorFromCart = async () => {
    if (cartCount === 0) return alert("Add some items first.");
    const ref = await buildNextRef();
    const rows = Object.values(cart).map(({ qty, snap }) => ({
      name: snap.name,
      specs: snap.specs || "",
      qty,
      unit_price: snap.mrp || 0, // default to MRP (editable)
      gst_percent: 0, // editable later
    }));
    setEditingQuote({
      id: null,
      ref,
      customer_name: "",
      phone: "",
      subject: "",
      rows,
      date: new Date(),
    });
    window.scrollTo(0, 0);
  };

  const editSavedQuote = async (qid) => {
    const { data, error } = await supabase
      .from("quotes")
      .select("*")
      .eq("id", qid)
      .maybeSingle();
    if (error || !data) return alert("Could not load quote.");
    const rows = (data.items || []).map((r) => ({
      name: r.name,
      specs: r.specs || "",
      qty: Number(r.qty || 0),
      unit_price: Number(r.unit_price || 0),
      gst_percent: Number(r.gst_percent || 0),
    }));
    setEditingQuote({
      id: data.id,
      ref: data.ref,
      customer_name: data.customer_name || "",
      phone: data.phone || "",
      subject: data.subject || "",
      rows,
      date: new Date(data.created_at),
    });
    window.scrollTo(0, 0);
  };

  /* ---------- compute totals for editor ---------- */
  const computeTotals = (rows) => {
    const subtotal = rows.reduce(
      (s, r) => s + Number(r.qty || 0) * Number(r.unit_price || 0),
      0
    );
    const gst_total = rows.reduce((s, r) => {
      const line = Number(r.qty || 0) * Number(r.unit_price || 0);
      return s + (line * Number(r.gst_percent || 0)) / 100;
    }, 0);
    return {
      subtotal,
      gst_total,
      grand_total: subtotal + gst_total,
    };
  };

  const saveQuote = async () => {
    if (!editingQuote) return;
    const rows = editingQuote.rows.filter((r) => Number(r.qty) > 0);
    if (rows.length === 0) return alert("At least one item is required.");
    const t = computeTotals(rows);
    const payload = {
      ref: editingQuote.ref,
      customer_name: editingQuote.customer_name || null,
      phone: editingQuote.phone || null,
      subject: editingQuote.subject || null,
      items: rows.map((r) => ({
        name: r.name,
        specs: r.specs || "",
        qty: Number(r.qty || 0),
        unit_price: Number(r.unit_price || 0),
        gst_percent: Number(r.gst_percent || 0),
        total:
          Number(r.qty || 0) * Number(r.unit_price || 0) +
          (Number(r.qty || 0) *
            Number(r.unit_price || 0) *
            Number(r.gst_percent || 0)) /
            100,
      })),
      subtotal: t.subtotal,
      gst_total: t.gst_total,
      grand_total: t.grand_total,
    };

    if (editingQuote.id) {
      const { error } = await supabase
        .from("quotes")
        .update(payload)
        .eq("id", editingQuote.id);
      if (error) return alert(error.message);
      alert("Quote updated ✅");
    } else {
      const { error } = await supabase.from("quotes").insert(payload);
      if (error) return alert(error.message);
      alert("Quote saved ✅");
    }
    await loadSavedQuotes();
  };

  const printQuote = () => {
    window.print();
  };

  /* ---------- UI ---------- */
  return (
    <div
      style={{
        fontFamily: "Arial, sans-serif",
        minHeight: "100vh",
        background: "linear-gradient(to bottom right,#f8f9fa,#eef2f7)",
      }}
    >
      {/* Top bar */}
      <div style={{ position: "relative" }}>
        <div style={{ textAlign: "center", marginBottom: 18 }}>
          <img
            src="/hvf-logo.png"
            alt="HVF Agency"
            style={{ width: 160, height: "auto", marginBottom: 8 }}
          />
          <h1 style={{ margin: 0 }}>HVF Machinery Catalog</h1>
          <p style={{ color: "#777", marginTop: 6 }}>
            by HVF Agency, Moranhat, Assam
          </p>
        </div>

        {/* Top-right login menu */}
        <div
          style={{
            position: "absolute",
            top: 12,
            right: 12,
          }}
        >
          <div style={{ position: "relative" }}>
            <button onClick={() => setMenuOpen((b) => !b)}>Login ▾</button>
            {menuOpen && (
              <div
                style={{
                  position: "absolute",
                  top: "110%",
                  right: 0,
                  background: "#fff",
                  border: "1px solid #ddd",
                  borderRadius: 8,
                  padding: 10,
                  minWidth: 220,
                  boxShadow: "0 8px 20px rgba(0,0,0,.08)",
                  zIndex: 10,
                }}
              >
                {/* Staff quick view */}
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    toggleStaffLogin();
                  }}
                  style={{
                    width: "100%",
                    marginBottom: 6,
                    background: staffMode ? "#ffeaea" : "#f1f1f1",
                    color: staffMode ? "#b30000" : "#333",
                  }}
                >
                  {staffMode ? "Logout Staff View" : "Login as Staff (PIN)"}
                </button>

                {/* Quotation access */}
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    toggleQuoteLogin();
                  }}
                  style={{ width: "100%", marginBottom: 6 }}
                >
                  {quoteMode ? "Exit Quotation Mode" : "Login for Quotation"}
                </button>

                {/* Admin login / logout */}
                {session ? (
                  <>
                    <button
                      onClick={() => {
                        setMenuOpen(false);
                        signOut();
                      }}
                      style={{ width: "100%" }}
                    >
                      Sign Out (Admin)
                    </button>
                    <div style={{ fontSize: 12, color: "#666", marginTop: 6 }}>
                      {isAdmin ? "Admin: ON" : "Not admin"} · UID:{" "}
                      {session.user?.id?.slice(0, 8)}…
                    </div>
                  </>
                ) : (
                  <>
                    {!showLogin ? (
                      <button
                        onClick={() => setShowLogin(true)}
                        style={{ width: "100%" }}
                      >
                        Login as Admin (Magic Link)
                      </button>
                    ) : (
                      <div style={{ display: "grid", gap: 6 }}>
                        <input
                          type="email"
                          placeholder="your@email.com"
                          value={loginEmail}
                          onChange={(e) => setLoginEmail(e.target.value)}
                          style={{
                            padding: "6px 10px",
                            borderRadius: 6,
                            border: "1px solid #ddd",
                          }}
                        />
                        <button onClick={sendLoginLink}>Send Login Link</button>
                        <button onClick={() => setShowLogin(false)}>
                          Cancel
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Admin Add Category button */}
      {isAdmin && (
        <div style={{ maxWidth: 1100, margin: "0 auto 10px", textAlign: "right" }}>
          <button onClick={onAddCategory}>+ Add Category</button>
        </div>
      )}

      {/* Admin Add Product Form */}
      {isAdmin && (
        <form
          onSubmit={onSave}
          style={{
            maxWidth: 1100,
            margin: "0 auto 18px",
            background: "#fff",
            padding: 12,
            borderRadius: 10,
            border: "1px solid #e8e8e8",
          }}
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1.2fr 1.2fr 1fr 1fr 1fr",
              gap: 10,
              alignItems: "center",
            }}
          >
            <input
              name="name"
              placeholder="Name *"
              value={form.name}
              onChange={onChange}
              required
            />
            <select
              name="category"
              value={form.category}
              onChange={onChange}
              required
            >
              <option value="">Select category *</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <input
              name="mrp"
              type="number"
              placeholder="MRP *"
              value={form.mrp}
              onChange={onChange}
              required
            />
            <input
              name="sell_price"
              type="number"
              placeholder="Selling Price"
              value={form.sell_price}
              onChange={onChange}
            />
            <input
              name="cost_price"
              type="number"
              placeholder="Cost Price"
              value={form.cost_price}
              onChange={onChange}
            />
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1.5fr 1fr",
              gap: 10,
              marginTop: 10,
              alignItems: "center",
            }}
          >
            <input
              name="specs"
              placeholder="Specs / Description"
              value={form.specs}
              onChange={onChange}
            />
            <input type="file" accept="image/*" onChange={onChange} />
          </div>

          <div style={{ marginTop: 10, textAlign: "center" }}>
            <button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save Product"}
            </button>
          </div>
        </form>
      )}

      {/* Search + Cart (quotation mode) */}
      <div style={{ maxWidth: 1100, margin: "0 auto 10px", display: "flex", gap: 8, alignItems: "center" }}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search products…"
          style={{
            flex: 1,
            padding: "8px 10px",
            borderRadius: 8,
            border: "1px solid #ddd",
            background: "#fff",
          }}
        />
        {quoteMode && (
          <>
            <button onClick={openQuoteEditorFromCart}>
              View Quote ({cartCount})
            </button>
            <button onClick={loadSavedQuotes}>Saved Quotes</button>
          </>
        )}
      </div>

      {/* Category pills */}
      <div style={{ textAlign: "center", marginBottom: 12 }}>
        {["All", ...categories].map((c) => (
          <button
            key={c}
            onClick={() => setCategory(c)}
            style={{
              margin: "0 6px 8px",
              padding: "6px 10px",
              borderRadius: 20,
              border: "1px solid #ddd",
              background: category === c ? "#1677ff" : "#fff",
              color: category === c ? "#fff" : "#333",
            }}
          >
            {c}
          </button>
        ))}
      </div>

      {/* Product grid OR Quote Editor / Saved Quotes */}
      <div style={{ maxWidth: 1100, margin: "0 auto 40px" }}>
        {editingQuote ? (
          <QuoteEditor
            editingQuote={editingQuote}
            setEditingQuote={setEditingQuote}
            computeTotals={computeTotals}
            saveQuote={saveQuote}
            printQuote={printQuote}
          />
        ) : (
          <>
            {quoteMode && savedQuotes.length > 0 && (
              <SavedQuotesPanel
                quotes={savedQuotes}
                onEdit={editSavedQuote}
                onPrint={async (id) => {
                  await editSavedQuote(id);
                  setTimeout(() => printQuote(), 300);
                }}
              />
            )}

            {loading ? (
              <p style={{ textAlign: "center" }}>Loading…</p>
            ) : (
              <div className="catalog-grid">
                {filtered.map((m) => (
                  <div key={m.id} className="card">
                    {/* White, centered, no-crop thumbnail */}
                    <div
                      className="thumb"
                      style={{
                        height: 240,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        background: "#ffffff",
                        borderBottom: "1px solid #eee",
                        borderTopLeftRadius: 10,
                        borderTopRightRadius: 10,
                        overflow: "hidden",
                      }}
                    >
                      {m.image_url && (
                        <img
                          src={m.image_url}
                          alt={m.name}
                          loading="lazy"
                          style={{
                            maxWidth: "100%",
                            maxHeight: "100%",
                            width: "auto",
                            height: "auto",
                            objectFit: "contain",
                            display: "block",
                            background: "transparent",
                          }}
                          onError={(e) =>
                            (e.currentTarget.style.display = "none")
                          }
                        />
                      )}
                    </div>

                    <div className="card-body">
                      <h3>{m.name}</h3>
                      {m.specs && (
                        <p style={{ color: "#666" }}>{m.specs}</p>
                      )}

                      {/* Always show MRP (no label) */}
                      <p style={{ fontWeight: 700 }}>
                        ₹{formatINRnoDecimals(m.mrp)}
                      </p>

                      {/* Staff/Admin sensitive prices */}
                      {(staffMode || isAdmin) && m.sell_price != null && (
                        <div
                          style={{
                            fontWeight: 700,
                            marginTop: -2,
                            marginBottom: 6,
                            display: "inline-flex",
                            alignItems: "baseline",
                            gap: 8,
                          }}
                        >
                          {/* Selling (red) */}
                          <span style={{ color: "#d32f2f" }}>
                            ₹{formatINRnoDecimals(m.sell_price)}
                          </span>

                          {/* For Admin only, add slash + Cost (yellow) */}
                          {isAdmin && m.cost_price != null && (
                            <>
                              <span style={{ color: "#bbb" }}>/</span>
                              <span style={{ color: "#d4a106" }}>
                                ₹{formatINRnoDecimals(m.cost_price)}
                              </span>
                            </>
                          )}
                        </div>
                      )}

                      {m.category && (
                        <p style={{ color: "#777", fontSize: 12 }}>
                          {m.category}
                        </p>
                      )}
                    </div>

                    {/* Quotation qty controls */}
                    {quoteMode && (
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "center",
                          gap: 8,
                          marginBottom: 10,
                        }}
                      >
                        <button onClick={() => addQty(m, -1)}>-</button>
                        <div
                          style={{
                            minWidth: 32,
                            textAlign: "center",
                            background: "#f7f7f7",
                            borderRadius: 6,
                            padding: "4px 6px",
                            border: "1px solid #eee",
                          }}
                        >
                          {cart[m.id]?.qty || 0}
                        </div>
                        <button onClick={() => addQty(m, 1)}>+</button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {msg && (
          <p style={{ textAlign: "center", color: "crimson", marginTop: 10 }}>
            {msg}
          </p>
        )}
      </div>
    </div>
  );
}

/* ---------------- Quote Editor ---------------- */
function QuoteEditor({
  editingQuote,
  setEditingQuote,
  computeTotals,
  saveQuote,
  printQuote,
}) {
  const rows = editingQuote.rows;
  const totals = computeTotals(rows);

  const setRow = (i, patch) => {
    const next = rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r));
    setEditingQuote({ ...editingQuote, rows: next });
  };

  const addEmptyRow = () => {
    setEditingQuote({
      ...editingQuote,
      rows: [
        ...rows,
        { name: "", specs: "", qty: 1, unit_price: 0, gst_percent: 0 },
      ],
    });
  };

  const removeRow = (i) => {
    const next = rows.filter((_, idx) => idx !== i);
    setEditingQuote({ ...editingQuote, rows: next });
  };

  return (
    <div
      style={{
        background: "#fff",
        border: "1px solid #e8e8e8",
        borderRadius: 10,
        padding: 16,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <div style={{ display: "grid", gap: 6, minWidth: 280 }}>
          <label>
            Customer Name
            <input
              value={editingQuote.customer_name}
              onChange={(e) =>
                setEditingQuote({ ...editingQuote, customer_name: e.target.value })
              }
            />
          </label>
          <label>
            Phone
            <input
              value={editingQuote.phone}
              onChange={(e) =>
                setEditingQuote({ ...editingQuote, phone: e.target.value })
              }
            />
          </label>
          <label>
            Subject
            <input
              value={editingQuote.subject}
              onChange={(e) =>
                setEditingQuote({ ...editingQuote, subject: e.target.value })
              }
            />
          </label>
        </div>

        <div style={{ textAlign: "right" }}>
          <div style={{ fontWeight: 700, fontSize: 18 }}>QUOTATION</div>
          <div>Ref: {editingQuote.ref}</div>
          <div>Date: {new Date(editingQuote.date).toLocaleDateString("en-IN")}</div>
        </div>
      </div>

      <div style={{ marginTop: 14, overflowX: "auto" }}>
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontSize: 14,
          }}
        >
          <thead>
            <tr>
              <th style={th}>Sl.</th>
              <th style={th}>Description</th>
              <th style={th}>Qty</th>
              <th style={th}>Unit Price</th>
              <th style={th}>GST %</th>
              <th style={th}>Total (Incl. GST)</th>
              <th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const line = Number(r.qty || 0) * Number(r.unit_price || 0);
              const lineGst =
                (line * Number(r.gst_percent || 0)) / 100;
              const lineTotal = line + lineGst;
              return (
                <tr key={i}>
                  <td style={tdCenter}>{i + 1}</td>
                  <td style={td}>
                    <input
                      value={r.name}
                      onChange={(e) => setRow(i, { name: e.target.value })}
                      placeholder="Item name"
                    />
                    <div>
                      <input
                        value={r.specs}
                        onChange={(e) => setRow(i, { specs: e.target.value })}
                        placeholder="Specs / description"
                        style={{ color: "#666" }}
                      />
                    </div>
                  </td>
                  <td style={tdCenter}>
                    <input
                      type="number"
                      value={r.qty}
                      onChange={(e) => setRow(i, { qty: Number(e.target.value || 0) })}
                      style={{ width: 70, textAlign: "right" }}
                    />
                  </td>
                  <td style={tdRight}>
                    <input
                      type="number"
                      value={r.unit_price}
                      onChange={(e) =>
                        setRow(i, { unit_price: Number(e.target.value || 0) })
                      }
                      style={{ width: 120, textAlign: "right" }}
                    />
                  </td>
                  <td style={tdRight}>
                    <input
                      type="number"
                      value={r.gst_percent}
                      onChange={(e) =>
                        setRow(i, { gst_percent: Number(e.target.value || 0) })
                      }
                      style={{ width: 80, textAlign: "right" }}
                    />
                  </td>
                  <td style={tdRight}>₹{formatINRnoDecimals(lineTotal)}</td>
                  <td style={tdCenter}>
                    <button onClick={() => removeRow(i)}>✕</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={7} style={{ paddingTop: 8 }}>
                <button onClick={addEmptyRow}>+ Add Row</button>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* Totals */}
      <div style={{ marginTop: 12, display: "grid", justifyContent: "end" }}>
        <div style={{ minWidth: 300 }}>
          <div style={sumRow}>
            <span>Subtotal</span>
            <b>₹{formatINRnoDecimals(totals.subtotal)}</b>
          </div>
          <div style={sumRow}>
            <span>GST Total</span>
            <b>₹{formatINRnoDecimals(totals.gst_total)}</b>
          </div>
          <div style={{ ...sumRow, borderTop: "1px dashed #ddd", paddingTop: 8 }}>
            <span>Grand Total</span>
            <b>₹{formatINRnoDecimals(totals.grand_total)}</b>
          </div>
        </div>
      </div>

      {/* Actions */}
      <div style={{ marginTop: 16, display: "flex", gap: 10 }}>
        <button onClick={saveQuote}>Save</button>
        <button onClick={printQuote}>Export / Print PDF</button>
        <button onClick={() => setEditingQuote(null)}>Back to Catalog</button>
      </div>

      {/* Fixed Terms & Bank details (simplified) */}
      <div style={{ marginTop: 18, color: "#444", fontSize: 13 }}>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>Terms & Conditions</div>
        <ul>
          <li>Price includes GST where applicable.</li>
          <li>Quotation valid for 30 days.</li>
          <li>Delivery Ex-stock / 2 weeks.</li>
          <li>Goods once sold cannot be taken back.</li>
          <li style={{ color: "crimson" }}>
            All machines in this quotation are non-exchangeable and non-returnable.
          </li>
        </ul>
        <div style={{ marginTop: 10 }}>
          <div style={{ fontWeight: 700 }}>Bank Details</div>
          <div>HVF AGENCY, ICICI Bank (Moran Branch)</div>
          <div>AC No: 19965500412 · IFSC: ICIC0001995</div>
        </div>
      </div>
    </div>
  );
}

function SavedQuotesPanel({ quotes, onEdit, onPrint }) {
  return (
    <div
      style={{
        background: "#fff",
        border: "1px solid #e8e8e8",
        borderRadius: 10,
        padding: 12,
        marginBottom: 14,
      }}
    >
      <div style={{ fontWeight: 700, marginBottom: 8 }}>Saved Quotations</div>
      <div style={{ display: "grid", gap: 8 }}>
        {quotes.map((q) => (
          <div
            key={q.id}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              border: "1px solid #eee",
              borderRadius: 8,
              padding: "8px 10px",
              background: "#fafafa",
            }}
          >
            <div>
              <div style={{ fontWeight: 700 }}>{q.ref}</div>
              <div style={{ fontSize: 12, color: "#666" }}>
                {q.customer_name || "—"} · ₹{formatINRnoDecimals(q.grand_total)} ·{" "}
                {new Date(q.created_at).toLocaleDateString("en-IN")}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => onEdit(q.id)}>Edit</button>
              <button onClick={() => onPrint(q.id)}>Print</button>
            </div>
          </div>
        ))}
        {quotes.length === 0 && <div style={{ color: "#777" }}>No saved quotes yet.</div>}
      </div>
    </div>
  );
}

/* table styles for editor */
const th = {
  textAlign: "left",
  borderBottom: "1px solid #e5e5e5",
  padding: "8px 6px",
  background: "#fafafa",
};
const td = { borderBottom: "1px solid #f0f0f0", padding: "8px 6px" };
const tdRight = { ...td, textAlign: "right" };
const tdCenter = { ...td, textAlign: "center" };
const sumRow = {
  display: "flex",
  justifyContent: "space-between",
  padding: "4px 0",
};