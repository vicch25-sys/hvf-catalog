import React, { useEffect, useMemo, useState } from "react";
import { createClient } from "@supabase/supabase-js";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

/* --- Supabase client --- */
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: true, autoRefreshToken: true },
});

/* --- Helpers --- */
const inr = (n) =>
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

/* Create APP/H### by counting existing quotes */
async function getNextQuoteNumber() {
  const { count, error } = await supabase
    .from("quotes")
    .select("*", { count: "exact", head: true });
  if (error) throw error;
  const next = (count || 0) + 1;
  return `APP/H${String(next).padStart(3, "0")}`;
}

/* --- App --- */
export default function App() {
  /*** DATA ***/
  const [items, setItems] = useState([]);
  const [categories, setCategories] = useState([]);
  const [category, setCategory] = useState("All");
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");

  /*** AUTH / MENUS ***/
  const [session, setSession] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loginEmail, setLoginEmail] = useState("");
  const [showLoginBox, setShowLoginBox] = useState(false);

  // staff quick view (PIN 2525)
  const [staffMode, setStaffMode] = useState(false);
  const toggleStaff = () => {
    if (staffMode) return setStaffMode(false);
    const pin = prompt("Enter staff PIN:");
    if ((pin || "").trim() === "2525") setStaffMode(true);
    else alert("Wrong PIN");
  };

  // quotation “cart” mode (PIN 9990)
  const [quoteMode, setQuoteMode] = useState(false);    // true = show qty steppers on catalog
  const [page, setPage] = useState("catalog");          // "catalog" | "quoteEditor"
  const enableQuoteMode = () => {
    if (quoteMode) {
      setQuoteMode(false);
      setPage("catalog");
      return;
    }
    const pin = prompt("Enter quotation PIN:");
    if ((pin || "").trim() === "9990") {
      setQuoteMode(true);
      setPage("catalog");
    } else alert("Wrong PIN");
  };

  /*** ADD/EDIT FORM (admin) ***/
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

  /* ---------- AUTH ---------- */
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
      } else setIsAdmin(false);
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
      } else setIsAdmin(false);
      setShowLoginBox(false);
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

  /* ---------- LOAD DATA ---------- */
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
    const { data } = await supabase.from("categories").select("name").order("name");
    setCategories((data || []).map((r) => r.name));
  };
  useEffect(() => {
    loadMachines();
    loadCategories();
  }, []);

  /* ---------- SEARCH / FILTER ---------- */
  const [search, setSearch] = useState("");
  const filtered = useMemo(() => {
    let arr = items;
    if (category !== "All") {
      arr = arr.filter(
        (m) => (m.category || "").toLowerCase() === category.toLowerCase()
      );
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      arr = arr.filter(
        (m) =>
          (m.name || "").toLowerCase().includes(q) ||
          (m.specs || "").toLowerCase().includes(q)
      );
    }
    return arr;
  }, [items, category, search]);

  /* ---------- ADMIN: ADD PRODUCT ---------- */
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
      const safeBase = form.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
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
        name: "", category: "", mrp: "", sell_price: "", cost_price: "", specs: "", imageFile: null,
      });
      await loadMachines();
      alert("Product added ✅");
    } catch (err) {
      console.error(err);
      alert(err.message);
    } finally {
      setSaving(false);
    }
  };

  /* ---------- QUOTE CART (works only in quoteMode on catalog) ---------- */
  const [cart, setCart] = useState({});
  const cartList = Object.values(cart);
  const cartCount = cartList.reduce((a, r) => a + (r.qty || 0), 0);
  const cartSubtotal = cartList.reduce((a, r) => a + (r.qty || 0) * (r.unit || 0), 0);

  const inc = (m) =>
    setCart((c) => {
      const prev = c[m.id] || { id: m.id, name: m.name, specs: m.specs || "", unit: Number(m.mrp || 0), qty: 0 };
      return { ...c, [m.id]: { ...prev, qty: prev.qty + 1 } };
    });
  const dec = (m) =>
    setCart((c) => {
      const prev = c[m.id];
      if (!prev) return c;
      const q = Math.max(0, prev.qty - 1);
      const nx = { ...prev, qty: q };
      const obj = { ...c };
      if (q === 0) delete obj[m.id];
      else obj[m.id] = nx;
      return obj;
    });

  /* ---------- QUOTE EDITOR HEADER ---------- */
  const [qHeader, setQHeader] = useState({
    number: "",
    date: todayStr(),
    customer_name: "",
    address: "",
    phone: "",
    subject: "",
  });

  const goToEditor = async () => {
    if (cartList.length === 0) return alert("Add at least 1 item to the quote.");
    if (!qHeader.number) {
      try {
        const num = await getNextQuoteNumber();
        setQHeader((h) => ({ ...h, number: num, date: todayStr() }));
      } catch {
        setQHeader((h) => ({ ...h, number: `APP/H${Date.now().toString().slice(-3)}` }));
      }
    }
    setPage("quoteEditor");
  };

  const backToCatalog = () => setPage("catalog");

  /* ---------- SAVE USING YOUR SCHEMA (quotes + quote_items) ---------- */
  const saveQuote = async () => {
    try {
      const number = qHeader.number || (await getNextQuoteNumber());
      const { data: qins, error: qerr } = await supabase
        .from("quotes")
        .insert({
          number,
          customer_name: qHeader.customer_name || null,
          phone: qHeader.phone || null,
          total: cartSubtotal,
        })
        .select("id,number")
        .single();
      if (qerr) throw qerr;

      const rows = cartList.map((r) => ({
        quote_id: qins.id,
        name: r.name,
        specs: r.specs || null,
        qty: r.qty,
        mrp: r.unit,
      }));
      if (rows.length) {
        const { error: ierr } = await supabase.from("quote_items").insert(rows);
        if (ierr) throw ierr;
      }
      setQHeader((h) => ({ ...h, number }));
      alert("Saved ✅");
      return qins.number;
    } catch (e) {
      console.error(e);
      alert("Save failed: " + e.message);
      return null;
    }
  };

  /* ---------- LOAD SAVED LIST / EDIT / PDF ---------- */
  const [saved, setSaved] = useState([]);
  const loadSaved = async () => {
    const { data } = await supabase
      .from("quotes")
      .select("id,number,customer_name,total,created_at")
      .order("created_at", { ascending: false });
    setSaved(data || []);
  };
  const editSaved = async (number) => {
    const { data: q } = await supabase.from("quotes").select("id,number,customer_name,phone").eq("number", number).maybeSingle();
    if (!q) return;
    const { data: lines } = await supabase
      .from("quote_items")
      .select("name,specs,qty,mrp")
      .eq("quote_id", q.id);

    const newCart = {};
    (lines || []).forEach((ln, idx) => {
      const id = `saved-${idx}`;
      newCart[id] = { id, name: ln.name, specs: ln.specs || "", unit: Number(ln.mrp || 0), qty: Number(ln.qty || 0) };
    });
    setCart(newCart);
    setQHeader((h) => ({
      ...h,
      number: q.number,
      customer_name: q.customer_name || "",
      phone: q.phone || "",
      date: todayStr(),
    }));
    setQuoteMode(true);
    setPage("quoteEditor");
  };

  /* ---------- CLEAN PDF (NOT web print) ---------- */
  const exportPDF = async () => {
    if (cartList.length === 0) return alert("Nothing to print.");

    // ensure quote number
    const num = qHeader.number || (await getNextQuoteNumber());
    setQHeader((h) => ({ ...h, number: num }));

    const doc = new jsPDF({ unit: "pt", format: "a4" });
    const pw = doc.internal.pageSize.getWidth();
    const margin = 40;

    // ----- LOGO -----
    let logoBottom = 24;
    try {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.src = "/hvf-logo.png";
      await new Promise((r) => (img.onload = r));
      const w = 110;
      const h = (img.height * w) / img.width;
      const x = (pw - w) / 2;
      const y = 24;
      doc.addImage(img, "PNG", x, y, w, h);
      logoBottom = y + h;
    } catch {}

    // ----- TITLE + HEADER LINES -----
    doc.setFont("helvetica", "bold");
    doc.setFontSize(16);
    doc.text("QUOTATION", pw / 2, logoBottom + 28, { align: "center" });

    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);

    // left block
    const L = margin;
    const rightBlockX = pw - margin - 180;
    let y0 = logoBottom + 40;

    doc.text(`Customer Name: ${qHeader.customer_name || ""}`, L, y0);
    y0 += 15;
    doc.text(`Address: ${qHeader.address || ""}`, L, y0);
    y0 += 15;
    doc.text(`Phone: ${qHeader.phone || ""}`, L, y0);

    // right block
    doc.text(`Ref: ${num}`, rightBlockX, logoBottom + 40);
    doc.text(`Date: ${qHeader.date || todayStr()}`, rightBlockX, logoBottom + 55);

    // intro line
    const introY = y0 + 28;
    doc.setFontSize(11);
    doc.text("Dear Sir/Madam,", L, introY);
    doc.text(
      "With reference to your enquiry we are pleased to offer you as under:",
      L,
      introY + 16
    );

      // ----- TABLE -----
  // Description with specs underneath in lighter line
  const body = cartList.map((r, i) => [
    String(i + 1),
    `${r.name || ""}${r.specs ? `\n(${r.specs})` : ""}`,
    String(r.qty || 0),
    `Rs ${inr(r.unit || 0)}`,                       // use "Rs " to avoid missing ₹ glyph
    `Rs ${inr((r.qty || 0) * (r.unit || 0))}`,
  ]);

  autoTable(doc, {
    startY: introY + 38,
    head: [["Sl.", "Description", "Qty", "Unit Price", "Total (Incl. GST)"]],
    body: body,                                      // <-- render rows
    styles: { fontSize: 10, cellPadding: 6, overflow: "linebreak" },
    headStyles: { fillColor: [230, 230, 230] },
    columnStyles: {
      0: { cellWidth: 28, halign: "center" },        // Sl.
      1: { cellWidth: 320 },                         // Description (+specs on next line)
      2: { cellWidth: 40, halign: "center" },        // Qty
      3: { cellWidth: 100, halign: "right" },        // Unit Price
      4: { cellWidth: 120, halign: "right" },        // Total
    },
    margin: { left: margin, right: margin },
    tableLineColor: [200, 200, 200],
    tableLineWidth: 0.5,
    theme: "grid",                                   // full borders
  });

  // ----- TOTALS (right aligned with table's right edge) -----
  const last = doc.lastAutoTable || null;
  // If for any reason the table isn't there, fall back to page width minus margins
  const tableRightX = last ? (margin + last.table.width) : (doc.internal.pageSize.getWidth() - margin);
  let totalsY = (last ? last.finalY : (introY + 38)) + 18;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.text(`Subtotal: Rs ${inr(cartSubtotal)}`, tableRightX, totalsY, { align: "right" });
  totalsY += 18;
  doc.text(`Grand Total: Rs ${inr(cartSubtotal)}`, tableRightX, totalsY, { align: "right" });

  // ----- TERMS & BANK -----
  const ty = totalsY + 36;                           // position terms below totals
  doc.setFontSize(11);
  doc.text("Terms & Conditions:", margin, ty);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.text(
    [
      "This quotation is valid for one month from the date of issue.",
      "Delivery is subject to stock availability and may take up to 2 weeks.",
      "Goods once sold are non-returnable and non-exchangeable.",
      "",
      "Yours Faithfully",
      "HVF Agency",
      "9957239143 / 9954425780",
      "",
      "BANK DETAILS",
      "HVF AGENCY",
      "ICICI BANK (Moran Branch)",
      "A/C No - 199505500412",
      "IFSC Code - ICIC0001995",
    ],
    margin,
    ty + 16
  );

  // open in new tab (download from there if needed)
  window.open(doc.output("bloburl"), "_blank");
}; // <-- end of exportPDF

  /*** UI ***/
  return (
    <div style={{ fontFamily: "Arial, sans-serif", minHeight: "100vh", background: "linear-gradient(to bottom right,#f8f9fa,#eef2f7)" }}>
      {/* top-right Login menu */}
      <div style={{ display: "flex", justifyContent: "flex-end", padding: "8px 16px" }}>
        <details>
          <summary style={{ cursor: "pointer", padding: "6px 12px", borderRadius: 6, background: "#f2f2f2" }}>Login</summary>
          <div style={{ position: "absolute", right: 16, marginTop: 6, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 8, padding: 8, minWidth: 210, boxShadow: "0 8px 24px rgba(0,0,0,.08)" }}>
            <button onClick={toggleStaff} style={{ width: "100%", marginBottom: 6 }}>
              {staffMode ? "Logout Staff View" : "Login as Staff (PIN)"}
            </button>
            <button onClick={() => setShowLoginBox(true)} style={{ width: "100%", marginBottom: 6 }}>
              Login as Admin (Email)
            </button>
            <button onClick={enableQuoteMode} style={{ width: "100%" }}>
              {quoteMode ? "Exit Quotation Mode" : "Login for Quotation (PIN)"}
            </button>
          </div>
        </details>
      </div>

      {/* Header */}
      <div style={{ textAlign: "center", marginBottom: 18 }}>
        <img src="/hvf-logo.png" alt="HVF Agency" style={{ width: 160, height: "auto", marginBottom: 8 }} />
        <h1 style={{ margin: 0 }}>HVF Machinery Catalog</h1>
        <p style={{ color: "#777", marginTop: 6 }}>by HVF Agency, Moranhat, Assam</p>

        {/* inline admin email box */}
        {!session && showLoginBox && (
          <div style={{ display: "inline-flex", gap: 8 }}>
            <input type="email" placeholder="your@email.com" value={loginEmail} onChange={(e) => setLoginEmail(e.target.value)} style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #ddd" }} />
            <button onClick={sendLoginLink}>Send Login Link</button>
            <button onClick={() => setShowLoginBox(false)} style={{ marginLeft: 6 }}>Cancel</button>
          </div>
        )}
        {session && (
          <div style={{ marginTop: 8 }}>
            <button onClick={signOut} style={{ marginRight: 8 }}>Sign Out</button>
            <span style={{ padding: "4px 8px", borderRadius: 6, background: isAdmin ? "#e8f6ed" : "#f7e8e8", color: isAdmin ? "#1f7a3f" : "#b11e1e", marginRight: 8 }}>
              {isAdmin ? "Admin: ON" : "Not admin"}
            </span>
            <span style={{ color: "#777", fontSize: 12 }}>UID: {session?.user?.id?.slice(0, 8)}…</span>
          </div>
        )}
      </div>

      {/* Search */}
      <div style={{ maxWidth: 1100, margin: "0 auto 10px", padding: "0 12px" }}>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search products…" style={{ width: "100%", padding: "10px 12px", borderRadius: 10, border: "1px solid #e5e7eb" }} />
      </div>

      {/* Categories */}
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

      {/* PAGE: CATALOG */}
      {page === "catalog" && (
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
                      background: "#fff",
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
                    <p style={{ fontWeight: 700 }}>₹{inr(m.mrp)}</p>
                    {(staffMode || isAdmin) && m.sell_price != null && (
                      <div style={{ fontWeight: 700, marginTop: -2, marginBottom: 6, display: "inline-flex", alignItems: "baseline", gap: 8 }}>
                        <span style={{ color: "#d32f2f" }}>₹{inr(m.sell_price)}</span>
                        {isAdmin && m.cost_price != null && (
                          <>
                            <span style={{ color: "#bbb" }}>/</span>
                            <span style={{ color: "#d4a106" }}>₹{inr(m.cost_price)}</span>
                          </>
                        )}
                      </div>
                    )}
                    {m.category && <p style={{ color: "#777", fontSize: 12 }}>{m.category}</p>}

                    {quoteMode && (
                      <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                        <button onClick={() => dec(m)}>-</button>
                        <div style={{ minWidth: 28, textAlign: "center" }}>
                          {cart[m.id]?.qty || 0}
                        </div>
                        <button onClick={() => inc(m)}>+</button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          {msg && <p style={{ textAlign: "center", color: "crimson", marginTop: 10 }}>{msg}</p>}
        </div>
      )}

      {/* PAGE: QUOTE EDITOR */}
      {page === "quoteEditor" && (
        <div
          style={{
            maxWidth: 1100,
            margin: "0 auto 40px",
            background: "#fff",
            border: "1px solid #e5e7eb",
            borderRadius: 12,
            padding: 14,
          }}
        >
          {/* header block */}
          <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
            {/* left: customer fields */}
            <div style={{ flex: 1 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <label>
                  <div style={{ fontSize: 12, color: "#666" }}>Customer Name</div>
                  <input
                    value={qHeader.customer_name}
                    onChange={(e) =>
                      setQHeader({ ...qHeader, customer_name: e.target.value })
                    }
                  />
                </label>

                <label>
                  <div style={{ fontSize: 12, color: "#666" }}>Address</div>
                  <input
                    value={qHeader.address}
                    onChange={(e) =>
                      setQHeader({ ...qHeader, address: e.target.value })
                    }
                  />
                </label>

                <label>
                  <div style={{ fontSize: 12, color: "#666" }}>Phone</div>
                  <input
                    value={qHeader.phone}
                    onChange={(e) =>
                      setQHeader({ ...qHeader, phone: e.target.value })
                    }
                  />
                </label>

                <div style={{ gridColumn: "1 / span 2", marginTop: 8, fontSize: 14 }}>
                  Dear Sir/Madam,<br />
                  With reference to your enquiry we are pleased to offer you as under:
                </div>
              </div>
            </div>

            {/* right: quotation meta */}
            <div style={{ width: 240, textAlign: "right" }}>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>QUOTATION</div>
              <div>Ref: {qHeader.number || "APP/H###"}</div>
              <div>Date: {qHeader.date}</div>
            </div>
          </div>

          {/* rows */}
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
                </tr>
              </thead>
              <tbody>
                {cartList.map((r, i) => (
                  <tr key={r.id}>
                    <td>{i + 1}</td>
                    <td>
                      <input value={r.name} onChange={(e) => setCart((c) => ({ ...c, [r.id]: { ...r, name: e.target.value } }))} />
                    </td>
                    <td>
                      <input value={r.specs} onChange={(e) => setCart((c) => ({ ...c, [r.id]: { ...r, specs: e.target.value } }))} />
                    </td>
                    <td>
                      <input
                        type="number"
                        value={r.qty}
                        min={0}
                        onChange={(e) =>
                          setCart((c) => ({ ...c, [r.id]: { ...r, qty: Number(e.target.value) } }))
                        }
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        value={r.unit}
                        min={0}
                        onChange={(e) =>
                          setCart((c) => ({ ...c, [r.id]: { ...r, unit: Number(e.target.value) } }))
                        }
                      />
                    </td>
                    <td style={{ textAlign: "right", fontWeight: 700 }}>
                      ₹{inr((r.qty || 0) * (r.unit || 0))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 24, marginTop: 16 }}>
              <div>Subtotal <b>₹{inr(cartSubtotal)}</b></div>
              <div>Grand Total <b>₹{inr(cartSubtotal)}</b></div>
            </div>

            <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
              <button onClick={async () => { const n = await saveQuote(); if (n && !qHeader.number) setQHeader((h) => ({ ...h, number: n })); }}>
                Save
              </button>
              <button onClick={exportPDF}>Export / Print PDF</button>
              <button onClick={backToCatalog}>Back to Catalog</button>
            </div>
          </div>
        </div>
      )}

      {/* FLOATING bottom-right controls */}
      <div style={{ position: "fixed", right: 16, bottom: 16, display: "flex", flexDirection: "column", gap: 8, zIndex: 20 }}>
        {quoteMode && (
          <button onClick={goToEditor}>View Quote ({cartCount})</button>
        )}
        <button
          onClick={() => {
            loadSaved();
            document.getElementById("saved-pop").style.display = "block";
          }}
        >
          Saved Quotes
        </button>
      </div>

      {/* Saved quotes popup */}
      <div
        id="saved-pop"
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
          <button onClick={() => (document.getElementById("saved-pop").style.display = "none")}>✕</button>
        </div>
        {saved.length === 0 ? (
          <div style={{ color: "#777" }}>No saved quotes yet.</div>
        ) : (
          saved.map((q) => (
            <div key={q.number} style={{ border: "1px solid #eee", borderRadius: 8, padding: 8, marginBottom: 6, display: "grid", gridTemplateColumns: "1fr auto", gap: 8 }}>
              <div>
                <div><b>{q.number}</b> — {q.customer_name || "—"}</div>
                <div style={{ fontSize: 12, color: "#666" }}>₹{inr(q.total || 0)}</div>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button onClick={() => editSaved(q.number)}>Edit</button>
                <button
                  onClick={async () => {
                    await editSaved(q.number);
                    await exportPDF();
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