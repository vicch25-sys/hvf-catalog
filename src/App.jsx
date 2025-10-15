import React, { useEffect, useMemo, useState } from "react";
import { createClient } from "@supabase/supabase-js";

/* --- Supabase client --- */
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: true, autoRefreshToken: true },
});

/* --- Helpers --- */
const formatINR = (val) =>
  Number(val ?? 0).toLocaleString("en-IN", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });

/* ===================== App ===================== */
export default function App() {
  /* data */
  const [items, setItems] = useState([]);
  const [categories, setCategories] = useState([]);
  const [category, setCategory] = useState("All");

  /* ui / status */
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");
  const [search, setSearch] = useState("");

  /* auth */
  const [session, setSession] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loginEmail, setLoginEmail] = useState("");
  const [showLoginChoices, setShowLoginChoices] = useState(false);
  const [showAdminEmail, setShowAdminEmail] = useState(false);

  /* staff quick view (PIN 2525) */
  const [staffMode, setStaffMode] = useState(false);

  /* quotation mode (PIN 9990) */
  const [quoteMode, setQuoteMode] = useState(false);
  const [view, setView] = useState("catalog"); // "catalog" | "quote" | "quotesList"
  const [cart, setCart] = useState({}); // { machineId: qty }

  /* add-product form (admin) */
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
      setShowAdminEmail(false);
      setShowLoginChoices(false);
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

  /* ---------- filters (incl. search) ---------- */
  const filtered = useMemo(() => {
    let list = items;
    if (category !== "All") {
      list = list.filter(
        (m) => (m.category || "").toLowerCase() === category.toLowerCase()
      );
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(
        (m) =>
          (m.name || "").toLowerCase().includes(q) ||
          (m.specs || "").toLowerCase().includes(q) ||
          (m.category || "").toLowerCase().includes(q)
      );
    }
    return list;
  }, [items, category, search]);

  /* ---------- categories (admin) ---------- */
  const onAddCategory = async () => {
    const name = (prompt("New category name:") || "").trim();
    if (!name) return;
    const { error } = await supabase.from("categories").insert({ name });
    if (error) return alert(error.message);
    await loadCategories();
    setCategory("All");
    alert("Category added ✅");
  };

  /* ---------- add product (admin) ---------- */
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

  /* ---------- staff & quotation logins ---------- */
  const doStaffToggle = () => {
    if (staffMode) return setStaffMode(false);
    const pin = prompt("Enter staff PIN:");
    if ((pin || "").trim() === "2525") setStaffMode(true);
    else alert("Wrong PIN");
  };
  const doQuoteToggle = () => {
    if (quoteMode) {
      setQuoteMode(false);
      setView("catalog");
      setCart({});
      return;
    }
    const pin = prompt("Enter quotation PIN:");
    if ((pin || "").trim() === "9990") {
      setQuoteMode(true);
      setView("catalog");
    } else {
      alert("Wrong PIN");
    }
  };

  /* ---------- cart helpers (quotation) ---------- */
  const inc = (id) =>
    setCart((c) => ({ ...c, [id]: (c[id] || 0) + 1 }));
  const dec = (id) =>
    setCart((c) => {
      const n = (c[id] || 0) - 1;
      const copy = { ...c };
      if (n <= 0) delete copy[id];
      else copy[id] = n;
      return copy;
    });
  const totalQty = Object.values(cart).reduce((a, b) => a + b, 0);

  const cartItems = useMemo(() => {
    const map = new Map(items.map((m) => [m.id, m]));
    return Object.entries(cart).map(([id, qty]) => ({
      qty,
      ...map.get(id),
    }));
  }, [cart, items]);

  /* ---------- quote number ---------- */
  async function nextQuoteNumber() {
    // Get last number and increment; fallback to APP/H001
    const { data } = await supabase
      .from("quotes")
      .select("number")
      .order("created_at", { ascending: false })
      .limit(1);
    const last = data?.[0]?.number || "APP/H001";
    const m = last.match(/^(.*\/H)(\d+)$/i);
    if (!m) return "APP/H001";
    const n = String(Number(m[2]) + 1).padStart(3, "0");
    return `${m[1]}${n}`;
  }

  /* ---------- save quote ---------- */
  async function saveQuote(rows, customerName, phone) {
    try {
      const qno = await nextQuoteNumber();
      const total = rows.reduce((sum, r) => sum + r.mrp * r.qty, 0);
      const { data: q, error: qErr } = await supabase
        .from("quotes")
        .insert({
          number: qno,
          customer_name: customerName || null,
          phone: phone || null,
          total,
        })
        .select()
        .single();
      if (qErr) throw qErr;

      const payload = rows.map((r) => ({
        quote_id: q.id,
        name: r.name,
        specs: r.specs || "",
        qty: r.qty,
        mrp: r.mrp,
      }));
      const { error: liErr } = await supabase.from("quote_items").insert(payload);
      if (liErr) throw liErr;

      alert(`Saved quotation ${qno} ✅`);
      return qno;
    } catch (e) {
      alert("Save failed: " + e.message);
      return null;
    }
  }

  /* ---------- views ---------- */
  return (
    <div
      style={{
        fontFamily: "Arial, sans-serif",
        minHeight: "100vh",
        background: "linear-gradient(to bottom right,#f8f9fa,#eef2f7)",
      }}
    >
      {/* Header */}
      <div style={{ position: "relative", textAlign: "center", marginBottom: 18 }}>
        <img
          src="/hvf-logo.png"
          alt="HVF Agency"
          style={{ width: 160, height: "auto", marginBottom: 8 }}
        />
        <h1 style={{ margin: 0 }}>HVF Machinery Catalog</h1>
        <p style={{ color: "#777", marginTop: 6 }}>by HVF Agency, Moranhat, Assam</p>

        {/* Top-right Login menu */}
        <div style={{ position: "absolute", top: 10, right: 14 }}>
          <div style={{ position: "relative", display: "inline-block" }}>
            <button
              onClick={() => setShowLoginChoices((v) => !v)}
              style={{
                padding: "6px 12px",
                borderRadius: 6,
                border: "1px solid #ddd",
                background: "#fff",
              }}
            >
              Login ▾
            </button>

            {showLoginChoices && (
              <div
                style={{
                  position: "absolute",
                  right: 0,
                  marginTop: 6,
                  background: "#fff",
                  border: "1px solid #ddd",
                  borderRadius: 8,
                  padding: 8,
                  width: 220,
                  zIndex: 5,
                  boxShadow: "0 8px 24px rgba(0,0,0,.08)",
                }}
              >
                <button
                  style={{ width: "100%", marginBottom: 6 }}
                  onClick={() => {
                    setShowAdminEmail(false);
                    doStaffToggle();
                  }}
                >
                  {staffMode ? "Logout Staff View" : "Login as Staff (PIN)"}
                </button>

                <button
                  style={{ width: "100%", marginBottom: 6 }}
                  onClick={() => {
                    setShowAdminEmail((s) => !s);
                  }}
                >
                  {session ? "Sign Out (Admin)" : "Login as Admin (email)"}
                </button>

                <button
                  style={{ width: "100%" }}
                  onClick={() => {
                    setShowAdminEmail(false);
                    doQuoteToggle();
                  }}
                >
                  {quoteMode ? "Exit Quotation Mode" : "Login for Quotation (PIN)"}
                </button>

                {showAdminEmail && !session && (
                  <div style={{ marginTop: 8 }}>
                    <input
                      type="email"
                      placeholder="your@email.com"
                      value={loginEmail}
                      onChange={(e) => setLoginEmail(e.target.value)}
                      style={{
                        width: "100%",
                        padding: "6px 10px",
                        borderRadius: 6,
                        border: "1px solid #ddd",
                        marginBottom: 6,
                      }}
                    />
                    <button style={{ width: "100%" }} onClick={sendLoginLink}>
                      Send Login Link
                    </button>
                  </div>
                )}

                {session && (
                  <div style={{ marginTop: 8 }}>
                    <button style={{ width: "100%" }} onClick={signOut}>
                      Sign Out
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Global search */}
        <div style={{ marginTop: 10 }}>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name/specs/category…"
            style={{
              width: "min(680px, 90vw)",
              padding: "8px 12px",
              borderRadius: 8,
              border: "1px solid #ddd",
            }}
          />
        </div>
      </div>

      {/* Admin controls */}
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
            <input name="name" placeholder="Name *" value={form.name} onChange={onChange} required />
            <select name="category" value={form.category} onChange={onChange} required>
              <option value="">Select category *</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <input name="mrp" type="number" placeholder="MRP *" value={form.mrp} onChange={onChange} required />
            <input name="sell_price" type="number" placeholder="Selling Price" value={form.sell_price} onChange={onChange} />
            <input name="cost_price" type="number" placeholder="Cost Price" value={form.cost_price} onChange={onChange} />
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
            <input name="specs" placeholder="Specs / Description" value={form.specs} onChange={onChange} />
            <input type="file" accept="image/*" onChange={onChange} />
          </div>

          <div style={{ marginTop: 10, textAlign: "center" }}>
            <button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save Product"}
            </button>
          </div>
        </form>
      )}

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

      {/* ===== Views ===== */}
      {view === "catalog" && (
        <CatalogGrid
          loading={loading}
          list={filtered}
          msg={msg}
          staffMode={staffMode}
          isAdmin={isAdmin}
          quoteMode={quoteMode}
          cart={cart}
          inc={inc}
          dec={dec}
        />
      )}

      {view === "quote" && (
        <QuotePage
          items={cartItems}
          onBack={() => setView("catalog")}
          onSave={saveQuote}
        />
      )}

      {view === "quotesList" && <SavedQuotes onBack={() => setView("catalog")} />}

      {/* Floating quote button */}
      {quoteMode && view === "catalog" && (
        <div style={{ position: "fixed", right: 16, bottom: 16 }}>
          <button
            onClick={() => setView("quote")}
            style={{
              position: "relative",
              padding: "10px 14px",
              borderRadius: 24,
              border: "1px solid #ddd",
              background: "#fff",
              boxShadow: "0 8px 20px rgba(0,0,0,.12)",
              fontWeight: 600,
            }}
          >
            View Quote
            <span
              style={{
                position: "absolute",
                top: -8,
                right: -8,
                background: "#1677ff",
                color: "#fff",
                fontSize: 12,
                borderRadius: 12,
                padding: "2px 7px",
              }}
            >
              {totalQty}
            </span>
          </button>

          <div style={{ marginTop: 8, textAlign: "right" }}>
            <button onClick={() => setView("quotesList")}>Saved Quotes</button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ===================== CatalogGrid ===================== */
function CatalogGrid({ loading, list, msg, staffMode, isAdmin, quoteMode, cart, inc, dec }) {
  return (
    <div style={{ maxWidth: 1100, margin: "0 auto 40px" }}>
      {loading ? (
        <p style={{ textAlign: "center" }}>Loading…</p>
      ) : (
        <div className="catalog-grid">
          {list.map((m) => (
            <div key={m.id} className="card" style={{ position: "relative" }}>
              {/* White thumbnail area, centered image, no crop */}
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
                    onError={(e) => (e.currentTarget.style.display = "none")}
                  />
                )}
              </div>

              <div className="card-body">
                <h3>{m.name}</h3>
                {m.specs && <p style={{ color: "#666" }}>{m.specs}</p>}

                {/* Always show MRP (no label) */}
                <p style={{ fontWeight: 700 }}>₹{formatINR(m.mrp)}</p>

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
                    <span style={{ color: "#d32f2f" }}>
                      ₹{formatINR(m.sell_price)}
                    </span>
                    {isAdmin && m.cost_price != null && (
                      <>
                        <span style={{ color: "#bbb" }}>/</span>
                        <span style={{ color: "#d4a106" }}>
                          ₹{formatINR(m.cost_price)}
                        </span>
                      </>
                    )}
                  </div>
                )}

                {m.category && (
                  <p style={{ color: "#777", fontSize: 12 }}>{m.category}</p>
                )}
              </div>

              {/* Quotation qty steppers */}
              {quoteMode && (
                <div
                  style={{
                    position: "absolute",
                    top: 10,
                    right: 10,
                    background: "#fff",
                    border: "1px solid #e5e5e5",
                    borderRadius: 20,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "4px 8px",
                  }}
                >
                  <button onClick={() => dec(m.id)}>-</button>
                  <span style={{ minWidth: 14, textAlign: "center" }}>{cart[m.id] || 0}</span>
                  <button onClick={() => inc(m.id)}>+</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {msg && <p style={{ textAlign: "center", color: "crimson", marginTop: 10 }}>{msg}</p>}
    </div>
  );
}

/* ===================== QuotePage ===================== */
function QuotePage({ items, onBack, onSave }) {
  const [rows, setRows] = useState(
    items.map((r) => ({
      id: r.id,
      name: r.name,
      specs: r.specs || "",
      qty: r.qty || 1,
      mrp: Number(r.mrp) || 0,
    }))
  );
  const [customerName, setCustomerName] = useState("");
  const [phone, setPhone] = useState("");

  const total = rows.reduce((sum, r) => sum + r.qty * r.mrp, 0);

  const update = (i, field, value) =>
    setRows((rs) => {
      const copy = [...rs];
      copy[i] = { ...copy[i], [field]: field === "qty" || field === "mrp" ? Number(value) : value };
      return copy;
    });

  const remove = (i) => setRows((rs) => rs.filter((_, idx) => idx !== i));

  const doPrint = () => {
    window.print();
  };

  const doSave = async () => {
    const qno = await onSave(rows, customerName, phone);
    if (qno) onBack();
  };

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto 40px", background: "#fff", padding: 16, borderRadius: 10, border: "1px solid #eee" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <h2 style={{ margin: 0 }}>Quotation</h2>
        <div>
          <button onClick={onBack} style={{ marginRight: 8 }}>← Back</button>
          <button onClick={doSave} style={{ marginRight: 8 }}>Save</button>
          <button onClick={doPrint}>Export as PDF</button>
        </div>
      </div>

      {/* Header fields */}
      <div style={{ display: "flex", gap: 12, marginBottom: 12 }}>
        <input
          placeholder="Customer Name"
          value={customerName}
          onChange={(e) => setCustomerName(e.target.value)}
          style={{ flex: 1, padding: "6px 10px", border: "1px solid #ddd", borderRadius: 6 }}
        />
        <input
          placeholder="Phone"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          style={{ width: 220, padding: "6px 10px", border: "1px solid #ddd", borderRadius: 6 }}
        />
      </div>

      {/* Table */}
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "#f6f6f6" }}>
              <th style={th}>#</th>
              <th style={th}>Description</th>
              <th style={th}>Qty</th>
              <th style={th}>MRP (₹)</th>
              <th style={th}>Line Total (₹)</th>
              <th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td style={td}>{i + 1}</td>
                <td style={{ ...td, minWidth: 320 }}>
                  <input
                    value={r.name}
                    onChange={(e) => update(i, "name", e.target.value)}
                    style={inputCell}
                  />
                  <textarea
                    rows={2}
                    placeholder="Specs / Description (optional)"
                    value={r.specs}
                    onChange={(e) => update(i, "specs", e.target.value)}
                    style={{ ...inputCell, marginTop: 6 }}
                  />
                </td>
                <td style={td}>
                  <input
                    type="number"
                    min={1}
                    value={r.qty}
                    onChange={(e) => update(i, "qty", e.target.value)}
                    style={inputCell}
                  />
                </td>
                <td style={td}>
                  <input
                    type="number"
                    min={0}
                    value={r.mrp}
                    onChange={(e) => update(i, "mrp", e.target.value)}
                    style={inputCell}
                  />
                </td>
                <td style={td}>&#8377;{formatINR(r.qty * r.mrp)}</td>
                <td style={td}>
                  <button onClick={() => remove(i)}>Remove</button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td style={td} colSpan={6}>
                  No items. Go back and add some from the catalog.
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr>
              <td style={td} colSpan={4} align="right">
                <strong>Total</strong>
              </td>
              <td style={td}>
                <strong>&#8377;{formatINR(total)}</strong>
              </td>
              <td style={td}></td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* Print styles (basic) */}
      <style>
        {`@media print {
          body { background: #fff !important; }
          button, input, textarea { display: none !important; }
          .catalog-grid { display: none !important; }
        }`}
      </style>
    </div>
  );
}

const th = { padding: "8px 10px", textAlign: "left", borderBottom: "1px solid #eee" };
const td = { padding: "8px 10px", borderBottom: "1px solid #f1f1f1", verticalAlign: "top" };
const inputCell = {
  width: "100%",
  padding: "6px 8px",
  border: "1px solid #ddd",
  borderRadius: 6,
  font: "inherit",
};

/* ===================== SavedQuotes ===================== */
function SavedQuotes({ onBack }) {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from("quotes")
        .select("id, number, created_at, customer_name, phone, total")
        .order("created_at", { ascending: false })
        .limit(50);
      setRows(data || []);
    })();
  }, []);
  return (
    <div style={{ maxWidth: 1100, margin: "0 auto 40px", background: "#fff", padding: 16, borderRadius: 10, border: "1px solid #eee" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <h2 style={{ margin: 0 }}>Saved Quotations</h2>
        <button onClick={onBack}>← Back</button>
      </div>
      {!rows ? (
        <p>Loading…</p>
      ) : rows.length === 0 ? (
        <p>No quotes saved yet.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "#f6f6f6" }}>
              <th style={th}>No.</th>
              <th style={th}>Date</th>
              <th style={th}>Customer</th>
              <th style={th}>Phone</th>
              <th style={th}>Total (₹)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td style={td}>{r.number}</td>
                <td style={td}>{new Date(r.created_at).toLocaleString()}</td>
                <td style={td}>{r.customer_name || "-"}</td>
                <td style={td}>{r.phone || "-"}</td>
                <td style={td}>&#8377;{formatINR(r.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}