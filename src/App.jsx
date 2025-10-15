import React, { useEffect, useMemo, useState } from "react";
import { createClient } from "@supabase/supabase-js";
import jsPDF from "jspdf";
import "jspdf-autotable";

/* --- Supabase client --- */
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: true, autoRefreshToken: true },
});

/* --- Helpers --- */
const formatINR = (n) =>
  Number(n ?? 0).toLocaleString("en-IN", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });

const todayStr = () => {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
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

  // auth
  const [session, setSession] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loginEmail, setLoginEmail] = useState("");
  const [showLogin, setShowLogin] = useState(false);

  // staff quick view (PIN 2525)
  const [staffMode, setStaffMode] = useState(false);
  const toggleStaffLogin = () => {
    if (staffMode) return setStaffMode(false);
    const pin = prompt("Enter staff PIN:");
    if ((pin || "").trim() === "2525") setStaffMode(true);
    else alert("Wrong PIN");
  };

  // quotation mode (PIN 9990)
  const [quoteMode, setQuoteMode] = useState(false);
  const toggleQuoteLogin = () => {
    if (quoteMode) return setQuoteMode(false);
    const pin = prompt("Enter quotation PIN:");
    if ((pin || "").trim() === "9990") setQuoteMode(true);
    else alert("Wrong PIN");
  };

  // add-product form
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

  /* ---------- filters + search ---------- */
  const [search, setSearch] = useState("");
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
          (m.specs || "").toLowerCase().includes(q)
      );
    }
    return arr;
  }, [items, category, search]);

  /* ---------- add category (admin) ---------- */
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
      // 1) upload image (safe filename)
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

      // 2) insert record
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

  /* ---------- quotation state ---------- */
  const [quote, setQuote] = useState({
    ref: "", // APP/H###
    date: todayStr(),
    customer_name: "",
    address: "",
    phone: "",
    subject: "",
    rows: [
      { name: "", specs: "", qty: 1, unit: 0 },
      { name: "", specs: "", qty: 1, unit: 0 },
      { name: "", specs: "", qty: 1, unit: 0 },
      { name: "", specs: "", qty: 1, unit: 0 },
    ],
  });

  const addRow = () =>
    setQuote((q) => ({
      ...q,
      rows: [...q.rows, { name: "", specs: "", qty: 1, unit: 0 }],
    }));
  const delRow = (i) =>
    setQuote((q) => ({ ...q, rows: q.rows.filter((_, idx) => idx !== i) }));
  const setRow = (i, patch) =>
    setQuote((q) => {
      const rows = [...q.rows];
      rows[i] = { ...rows[i], ...patch };
      return { ...q, rows };
    });

  const subTotal = quote.rows.reduce(
    (sum, r) => sum + Number(r.qty || 0) * Number(r.unit || 0),
    0
  );
  const grandTotal = subTotal;

  // cart add from catalog when in quoteMode
  const addToQuote = (it) => {
    setQuote((q) => ({
      ...q,
      rows: [
        ...q.rows,
        { name: it.name || "", specs: it.specs || "", qty: 1, unit: it.mrp || 0 },
      ],
    }));
  };

  /* ---------- ref number helper (APP/H001…) ---------- */
  const getNextRef = async () => {
    // Uses table quote_counters(seq) with single row id=1
    const { data: counter } = await supabase
      .from("quote_counters")
      .select("seq")
      .eq("id", 1)
      .maybeSingle();
    let next = (counter?.seq ?? 0) + 1;
    await supabase
      .from("quote_counters")
      .upsert({ id: 1, seq: next }, { onConflict: "id" });
    return `APP/H${String(next).padStart(3, "0")}`;
  };

  /* ---------- save / load quotes ---------- */
  const saveQuote = async () => {
    try {
      const ref = quote.ref || (await getNextRef());
      const payload = {
        ref,
        date: quote.date,
        customer_name: quote.customer_name,
        address: quote.address,
        phone: quote.phone,
        subject: quote.subject,
        rows: quote.rows,
        subtotal: subTotal,
        grand_total: grandTotal,
      };
      await supabase.from("quotes").upsert(payload, { onConflict: "ref" });
      setQuote((q) => ({ ...q, ref }));
      alert("Saved ✅");
    } catch (e) {
      console.error(e);
      alert("Save failed: " + e.message);
    }
  };

  const [savedQuotes, setSavedQuotes] = useState([]);
  const loadSaved = async () => {
    const { data } = await supabase
      .from("quotes")
      .select("ref,date,customer_name,grand_total")
      .order("created_at", { ascending: false });
    setSavedQuotes(data || []);
  };

  /* ---------- PDF export (clean doc, not the web page) ---------- */
  const exportPDF = async () => {
    if (!quote.ref) await saveQuote();

    const doc = new jsPDF({ unit: "pt", format: "a4" }); // 595x842 pt
    const pageWidth = doc.internal.pageSize.getWidth();

    // Logo
    try {
      // uses your existing /public/hvf-logo.png
      // (Vite will serve it at /hvf-logo.png)
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.src = "/hvf-logo.png";
      await new Promise((res) => (img.onload = res));
      const logoW = 120;
      const logoH = (img.height * logoW) / img.width;
      doc.addImage(img, "PNG", (pageWidth - logoW) / 2, 28, logoW, logoH);
    } catch {}

    // Title
    doc.setFont("helvetica", "bold");
    doc.setFontSize(18);
    doc.text("HVF Machinery Catalog", pageWidth / 2, 95, { align: "center" });

    // Header (left)
    doc.setFontSize(10);
    doc.setFont("helvetica", "normal");
    const leftX = 40;
    const rightX = pageWidth - 220;

    doc.text(`Customer Name: ${quote.customer_name || ""}`, leftX, 130);
    doc.text(`Address: ${quote.address || ""}`, leftX, 145);
    doc.text(`Phone: ${quote.phone || ""}`, leftX, 160);
    doc.text(`Subject: ${quote.subject || ""}`, leftX, 175);

    // Header (right)
    doc.setFont("helvetica", "bold");
    doc.text("QUOTATION", rightX + 90, 120, { align: "center" });
    doc.setFont("helvetica", "normal");
    doc.text(`Ref: ${quote.ref || "APP/H###"}`, rightX, 140);
    doc.text(`Date: ${quote.date || todayStr()}`, rightX, 155);

    // Table
    const body = quote.rows.map((r, i) => [
      String(i + 1),
      r.name || "",
      r.specs || "",
      String(r.qty || 0),
      `₹${formatINR(r.unit || 0)}`,
      `₹${formatINR((r.qty || 0) * (r.unit || 0))}`,
    ]);

    doc.autoTable({
      startY: 200,
      styles: { fontSize: 10 },
      headStyles: { fillColor: [240, 240, 240] },
      head: [["Sl.", "Description", "Specs / Description", "Qty", "Unit Price", "Total (Incl. GST)"]],
      body,
      columnStyles: {
        0: { halign: "center", cellWidth: 30 },
        1: { cellWidth: 160 },
        2: { cellWidth: 170 },
        3: { halign: "center", cellWidth: 40 },
        4: { halign: "right", cellWidth: 90 },
        5: { halign: "right", cellWidth: 100 },
      },
    });

    // Totals
    const y = doc.lastAutoTable.finalY + 16;
    doc.text(`Subtotal: ₹${formatINR(subTotal)}`, pageWidth - 180, y);
    doc.text(`Grand Total: ₹${formatINR(grandTotal)}`, pageWidth - 180, y + 18);

    // Terms & Bank (simple; you can expand later)
    const ty = y + 55;
    doc.setFont("helvetica", "bold");
    doc.text("Terms & Conditions:", leftX, ty);
    doc.setFont("helvetica", "normal");
    doc.text(
      [
        "Price will be including GST where applicable.",
        "This quotation is valid for one month only.",
        "Delivery ex-stock/2 weeks. Goods once sold cannot be taken back.",
      ],
      leftX,
      ty + 14
    );

    const by = ty + 70;
    doc.setFont("helvetica", "bold");
    doc.text("Bank Details:", leftX, by);
    doc.setFont("helvetica", "normal");
    doc.text(
      [
        "HVF AGENCY",
        "ICICI BANK (Moran Branch)  A/C: 19956550412",
        "IFSC: ICIC0001995",
      ],
      leftX,
      by + 14
    );

    doc.save(`${quote.ref || "quotation"}.pdf`);
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
      {/* top bar */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 16px" }}>
        <div />
        <div>
          <div className="login-menu" style={{ position: "relative" }}>
            <details>
              <summary style={{ cursor: "pointer", padding: "6px 12px", borderRadius: 6, background: "#f2f2f2" }}>
                Login
              </summary>
              <div
                style={{
                  position: "absolute",
                  right: 0,
                  marginTop: 6,
                  background: "#fff",
                  border: "1px solid #e5e7eb",
                  borderRadius: 8,
                  padding: 8,
                  minWidth: 200,
                  boxShadow: "0 8px 24px rgba(0,0,0,.08)",
                  zIndex: 5,
                }}
              >
                <button onClick={toggleStaffLogin} style={{ width: "100%", marginBottom: 6 }}>
                  {staffMode ? "Logout Staff View" : "Login as Staff (PIN)"}
                </button>
                <button
                  onClick={() => setShowLogin(true)}
                  style={{ width: "100%", marginBottom: 6 }}
                >
                  Login as Admin (Email)
                </button>
                <button onClick={toggleQuoteLogin} style={{ width: "100%" }}>
                  {quoteMode ? "Exit Quotation Mode" : "Login for Quotation (PIN)"}
                </button>
              </div>
            </details>
          </div>
        </div>
      </div>

      {/* Header */}
      <div style={{ textAlign: "center", marginBottom: 18 }}>
        <img src="/hvf-logo.png" alt="HVF Agency" style={{ width: 160, height: "auto", marginBottom: 8 }} />
        <h1 style={{ margin: 0 }}>HVF Machinery Catalog</h1>
        <p style={{ color: "#777", marginTop: 6 }}>by HVF Agency, Moranhat, Assam</p>

        {/* Admin email login row */}
        {!session && showLogin && (
          <div style={{ display: "inline-flex", gap: 8 }}>
            <input
              type="email"
              placeholder="your@email.com"
              value={loginEmail}
              onChange={(e) => setLoginEmail(e.target.value)}
              style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #ddd" }}
            />
            <button onClick={sendLoginLink}>Send Login Link</button>
            <button onClick={() => setShowLogin(false)} style={{ marginLeft: 6 }}>
              Cancel
            </button>
          </div>
        )}
        {session && (
          <div style={{ marginTop: 8 }}>
            <button onClick={signOut} style={{ marginRight: 8 }}>Sign Out</button>
            <span
              style={{
                padding: "4px 8px",
                borderRadius: 6,
                background: isAdmin ? "#e8f6ed" : "#f7e8e8",
                color: isAdmin ? "#1f7a3f" : "#b11e1e",
                marginRight: 8,
              }}
            >
              {isAdmin ? "Admin: ON" : "Not admin"}
            </span>
            <span style={{ color: "#777", fontSize: 12 }}>
              UID: {session.user?.id?.slice(0, 8)}…
            </span>
          </div>
        )}
      </div>

      {/* Search */}
      <div style={{ maxWidth: 1100, margin: "0 auto 10px", padding: "0 12px" }}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search products…"
          style={{ width: "100%", padding: "10px 12px", borderRadius: 10, border: "1px solid #e5e7eb" }}
        />
      </div>

      {/* Admin Add Category button */}
      {isAdmin && !quoteMode && (
        <div style={{ maxWidth: 1100, margin: "0 auto 10px", textAlign: "right" }}>
          <button onClick={onAddCategory}>+ Add Category</button>
        </div>
      )}

      {/* Admin Add Product Form */}
      {isAdmin && !quoteMode && (
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
                <option key={c} value={c}>{c}</option>
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
            <button type="submit" disabled={saving}>{saving ? "Saving…" : "Save Product"}</button>
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

      {/* Either Catalog (default) OR Quotation editor */}
      {!quoteMode ? (
        <div style={{ maxWidth: 1100, margin: "0 auto 40px" }}>
          {loading ? (
            <p style={{ textAlign: "center" }}>Loading…</p>
          ) : (
            <div className="catalog-grid">
              {filtered.map((m) => (
                <div key={m.id} className="card">
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

                    {/* MRP (no label) */}
                    <p style={{ fontWeight: 700 }}>₹{formatINR(m.mrp)}</p>

                    {/* Staff/Admin prices */}
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

                    {/* Add to quote when in quoteMode? (hide) */}
                    {!quoteMode && (
                      <button onClick={() => { setQuote((q) => ({ ...q, date: todayStr() })); setQuoteMode(false); }}>
                        &nbsp;
                      </button>
                    )}
                    {quoteMode && (
                      <button onClick={() => addToQuote(m)}>Add to Quote</button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          {msg && (
            <p style={{ textAlign: "center", color: "crimson", marginTop: 10 }}>
              {msg}
            </p>
          )}
        </div>
      ) : (
        // ======= QUOTATION EDITOR =======
        <div style={{ maxWidth: 1100, margin: "0 auto 40px", background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div style={{ flex: 1, paddingRight: 10 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <label>
                  <div style={{ fontSize: 12, color: "#666" }}>Customer Name</div>
                  <input value={quote.customer_name} onChange={(e) => setQuote({ ...quote, customer_name: e.target.value })} />
                </label>
                <label>
                  <div style={{ fontSize: 12, color: "#666" }}>Phone</div>
                  <input value={quote.phone} onChange={(e) => setQuote({ ...quote, phone: e.target.value })} />
                </label>
                <label style={{ gridColumn: "1 / span 2" }}>
                  <div style={{ fontSize: 12, color: "#666" }}>Address</div>
                  <input value={quote.address} onChange={(e) => setQuote({ ...quote, address: e.target.value })} />
                </label>
                <label style={{ gridColumn: "1 / span 2" }}>
                  <div style={{ fontSize: 12, color: "#666" }}>Subject</div>
                  <input value={quote.subject} onChange={(e) => setQuote({ ...quote, subject: e.target.value })} />
                </label>
              </div>
            </div>

            <div style={{ width: 240, textAlign: "right" }}>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>QUOTATION</div>
              <div>Ref: {quote.ref || "APP/H###"}</div>
              <div>Date: {quote.date}</div>
            </div>
          </div>

          {/* Table */}
          <div style={{ marginTop: 12 }}>
            <table className="qtable">
              <thead>
                <tr>
                  <th style={{ width: 40 }}>Sl.</th>
                  <th style={{ width: 220 }}>Description</th>
                  <th>Specs / description</th>
                  <th style={{ width: 80 }}>Qty</th>
                  <th style={{ width: 120 }}>Unit Price</th>
                  <th style={{ width: 130 }}>Total (Incl. GST)</th>
                  <th style={{ width: 40 }}></th>
                </tr>
              </thead>
              <tbody>
                {quote.rows.map((r, i) => (
                  <tr key={i}>
                    <td>{i + 1}</td>
                    <td>
                      <input
                        value={r.name}
                        onChange={(e) => setRow(i, { name: e.target.value })}
                        placeholder="Item name"
                      />
                    </td>
                    <td>
                      <input
                        value={r.specs}
                        onChange={(e) => setRow(i, { specs: e.target.value })}
                        placeholder="Specs / description"
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        step="1"
                        min="0"
                        value={r.qty}
                        onChange={(e) => setRow(i, { qty: Number(e.target.value) })}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        step="1"
                        min="0"
                        value={r.unit}
                        onChange={(e) => setRow(i, { unit: Number(e.target.value) })}
                      />
                    </td>
                    <td style={{ textAlign: "right", fontWeight: 700 }}>
                      ₹{formatINR((r.qty || 0) * (r.unit || 0))}
                    </td>
                    <td>
                      <button onClick={() => delRow(i)}>×</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div style={{ marginTop: 8 }}>
              <button onClick={addRow}>+ Add Row</button>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 24, marginTop: 16 }}>
              <div>Subtotal <b>₹{formatINR(subTotal)}</b></div>
              <div>Grand Total <b>₹{formatINR(grandTotal)}</b></div>
            </div>

            <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
              <button onClick={saveQuote}>Save</button>
              <button onClick={exportPDF}>Export / Print PDF</button>
              <button onClick={() => setQuoteMode(false)}>Back to Catalog</button>
            </div>

            {/* Terms (view-only on page) */}
            <div style={{ marginTop: 18 }}>
              <h4>Terms & Conditions</h4>
              <ul style={{ marginTop: 6, color: "#444" }}>
                <li>Price will be including GST where applicable.</li>
                <li>This quotation is valid for one month only.</li>
                <li>Delivery ex-stock/2 weeks.</li>
                <li>Goods once sold cannot be taken back.</li>
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* FLOATING controls (bottom-right): View Quote + Saved Quotes (works in both modes) */}
      <div
        style={{
          position: "fixed",
          right: 16,
          bottom: 16,
          display: "flex",
          flexDirection: "column",
          gap: 8,
          zIndex: 20,
        }}
      >
        {quoteMode && (
          <button
            onClick={() => {
              const c = quote.rows.filter((r) => (r.qty || 0) > 0).length;
              alert(`You have ${c} rows in the quote.`);
            }}
          >
            View Quote ({quote.rows.filter((r) => (r.qty || 0) > 0).length})
          </button>
        )}
        <button
          onClick={() => {
            loadSaved();
            const list = document.getElementById("saved-quotes-pop");
            list.style.display = "block";
          }}
        >
          Saved Quotes
        </button>
      </div>

      {/* Saved quotes popup */}
      <div
        id="saved-quotes-pop"
        style={{
          display: "none",
          position: "fixed",
          right: 16,
          bottom: 70,
          background: "#fff",
          border: "1px solid #e5e7eb",
          borderRadius: 10,
          padding: 10,
          width: 360,
          maxHeight: 380,
          overflow: "auto",
          boxShadow: "0 8px 24px rgba(0,0,0,.15)",
          zIndex: 25,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
          <b>Saved Quotes</b>
          <button onClick={() => (document.getElementById("saved-quotes-pop").style.display = "none")}>✕</button>
        </div>
        {savedQuotes.length === 0 ? (
          <div style={{ color: "#777" }}>No saved quotes yet.</div>
        ) : (
          savedQuotes.map((q) => (
            <div
              key={q.ref}
              style={{
                border: "1px solid #eee",
                borderRadius: 8,
                padding: 8,
                marginBottom: 6,
                display: "grid",
                gridTemplateColumns: "1fr auto",
                gap: 8,
              }}
            >
              <div>
                <div><b>{q.ref}</b> — {q.customer_name}</div>
                <div style={{ fontSize: 12, color: "#666" }}>
                  {q.date} • ₹{formatINR(q.grand_total)}
                </div>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  onClick={async () => {
                    const { data } = await supabase
                      .from("quotes")
                      .select("*")
                      .eq("ref", q.ref)
                      .maybeSingle();
                    if (data) {
                      setQuote({
                        ref: data.ref,
                        date: data.date,
                        customer_name: data.customer_name || "",
                        address: data.address || "",
                        phone: data.phone || "",
                        subject: data.subject || "",
                        rows: data.rows || [],
                      });
                      setQuoteMode(true);
                    }
                  }}
                >
                  Edit
                </button>
                <button
                  onClick={async () => {
                    const { data } = await supabase
                      .from("quotes")
                      .select("*")
                      .eq("ref", q.ref)
                      .maybeSingle();
                    if (data) {
                      setQuote({
                        ref: data.ref,
                        date: data.date,
                        customer_name: data.customer_name || "",
                        address: data.address || "",
                        phone: data.phone || "",
                        subject: data.subject || "",
                        rows: data.rows || [],
                      });
                      await exportPDF();
                    }
                  }}
                >
                  PDF
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}