import React, { useEffect, useMemo, useState } from "react";
import { createClient } from "@supabase/supabase-js";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

// ---- PDF font loader (for ₹) ----
let rupeeFontLoaded = false;

function ab2b64(buf) {
  // robust ArrayBuffer -> base64 for large files
  let binary = "";
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function loadRupeeFont(doc) {
  if (rupeeFontLoaded) return;

  // Fetch both Regular and Bold (make sure these files exist in public/fonts/)
  const [regRes, boldRes] = await Promise.all([
    fetch("/fonts/NotoSans-Regular.ttf"),
    fetch("/fonts/NotoSans-Bold.ttf"),      // if you didn't add bold, remove this + below two bold lines
  ]);

  const [regBuf, boldBuf] = await Promise.all([
    regRes.arrayBuffer(),
    boldRes.arrayBuffer(),
  ]);

  const regB64  = ab2b64(regBuf);
  const boldB64 = ab2b64(boldBuf);

  // Register Regular
  doc.addFileToVFS("NotoSans-Regular.ttf", regB64);
  doc.addFont("NotoSans-Regular.ttf", "NotoSans", "normal");

  // Register Bold
  doc.addFileToVFS("NotoSans-Bold.ttf", boldB64);
  doc.addFont("NotoSans-Bold.ttf", "NotoSans", "bold");

  rupeeFontLoaded = true;
}

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

/* ===== Step 1: persist quote UI state (ADD THIS BLOCK) ===== */
const LS_KEY = "hvfQuoteState";
const loadQuoteState = () => {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || "{}"); }
  catch { return {}; }
};
const saveQuoteState = (s) =>
  localStorage.setItem(LS_KEY, JSON.stringify(s));
/* ========================================================== */

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

// Create a new editable blank line item (not in catalog)
const addBlankRow = () => {
  const id = `custom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  setCart((c) => ({
    ...c,
    [id]: { id, name: "", specs: "", unit: 0, qty: 1 },
  }));
};

// remove one line item by id
const removeRow = (id) =>
  setCart((c) => {
    const nx = { ...c };
    delete nx[id];
    return nx;
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

// --- Persist quote state in localStorage so refresh won't log out ---
useEffect(() => {
  const saved = localStorage.getItem("quoteState");
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      if (parsed.cart) setCart(parsed.cart);
      if (parsed.qHeader) setQHeader(parsed.qHeader);
      if (parsed.page) setPage(parsed.page);
      if (parsed.quoteMode) setQuoteMode(parsed.quoteMode);
    } catch (e) {
      console.error("Failed to restore quote state", e);
    }
  }
}, []);

// whenever cart, qHeader, page, or quoteMode changes, save them
useEffect(() => {
  localStorage.setItem(
    "quoteState",
    JSON.stringify({ cart, qHeader, page, quoteMode })
  );
}, [cart, qHeader, page, quoteMode]);

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
  const contentW = pw - margin * 2; // width inside margins

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

  // left block (customer info) — To, + bold details (name, address, phone)
const L = margin;
let y0 = logoBottom + 40;                // start position below the logo

// "To," line
doc.setFont("helvetica", "normal");
doc.setFontSize(11);
doc.text("To,", L, y0);
y0 += 18;

// bold customer details (no labels)
doc.setFont("helvetica", "bold");
doc.text(String(qHeader.customer_name || ""), L, y0);
y0 += 16;
doc.text(String(qHeader.address || ""), L, y0);
y0 += 16;
doc.text(String(qHeader.phone || ""), L, y0);

// (leave font as-is; the right-block code sets it back to normal anyway)

  // right block (aligned with table right edge)
const tableRightX = doc.internal.pageSize.getWidth() - margin;

doc.setFont("helvetica", "normal");
doc.setFontSize(10);

doc.text(`Ref: ${num}`, tableRightX, logoBottom + 40, { align: "right" });
doc.text(`Date: ${qHeader.date || todayStr()}`, tableRightX, logoBottom + 55, { align: "right" });

  // intro line (fixed)
  const introY = y0 + 28;
  doc.setFontSize(11);
  doc.text("Dear Sir/Madam,", L, introY);
  doc.text("With reference to your enquiry we are pleased to offer you as under:", L, introY + 16);

  // ----- TABLE (always fits) -----
// Build body: keep specs as a newline in the raw text
const body = cartList.map((r, i) => [
  String(i + 1),
  `${r.name || ""}${r.specs ? `\n(${r.specs})` : ""}`, // name on line 1, specs on line 2
  String(r.qty || 0),
  inr(r.unit || 0),                          // plain number (no "Rs")
  inr((r.qty || 0) * (r.unit || 0)),         // plain number (no "Rs")
]);

// Column widths that sum to content width
const colSl = 28;
const colQty = 40;
const colUnit = 90;
const colTotal = 110;
const colDesc = Math.max(120, contentW - (colSl + colQty + colUnit + colTotal)); // remainder

autoTable(doc, {
  startY: introY + 38,
  head: [["Sl.", "Description", "Qty", "Unit Price", "Total (Incl. GST)"]],
  body,

  styles: { fontSize: 10, cellPadding: 6, overflow: "linebreak", textColor: [0, 0, 0] },
  headStyles: { fillColor: [230, 230, 230], textColor: [0, 0, 0], fontStyle: "bold" },
  columnStyles: {
    0: { cellWidth: colSl,   halign: "center" },
    1: { cellWidth: colDesc },                   // description
    2: { cellWidth: colQty,  halign: "center" },
    3: { cellWidth: colUnit, halign: "right" },
    4: { cellWidth: colTotal,halign: "right" },
  },
  margin: { left: margin, right: margin },
  tableLineColor: [200, 200, 200],
  tableLineWidth: 0.5,
  theme: "grid",

  // Keep two-line height; we'll draw specs ourselves as a second line.
  didParseCell: (data) => {
    if (data.section !== "body") return;
    if (data.column.index !== 1) return; // Description only
    const raw = (data.cell.raw ?? "").toString();
    const nl = raw.indexOf("\n(");
    if (nl === -1) return;

    const name  = raw.slice(0, nl);
    const specs = raw.slice(nl); // includes "("

    // Reserve two lines of height; leave 2nd line blank so plugin won't draw it.
    data.cell.text = [name, " "];
    // Stash specs so we can render them precisely in didDrawCell.
    data.cell._specs = specs;
  },

  didDrawCell: (data) => {
    if (data.section !== "body") return;
    if (data.column.index !== 1) return; // Description only
    const specs = data.cell && data.cell._specs;
    if (!specs) return;

    // Resolve paddings safely (jspdf-autotable v3+)
    const cellPad = (side) => {
      if (typeof data.cell.padding === "function") return data.cell.padding(side);
      const cp = data.cell.styles?.cellPadding;
      if (typeof cp === "number") return cp;
      if (cp && typeof cp === "object") return cp[side] ?? 6;
      return 6;
    };
    const padLeft  = cellPad("left");
    const padRight = cellPad("right");
    const padTop   = cellPad("top");

    const x = data.cell.x + padLeft;

    // Baselines based on table body font
    const fsMain = (data.row.styles && data.row.styles.fontSize) || 10;
    const lineH  = fsMain * 1.15;            // approx line height
    const specsY = data.cell.y + padTop + lineH; // exactly one line under the name

    // Wrap specs to stay within the cell
    const maxW    = data.cell.width - padLeft - padRight;
    const wrapped = doc.splitTextToSize(specs, maxW);

    // Draw specs 15% smaller & lighter
    const prevSize = doc.getFontSize();
    doc.setFontSize(prevSize * 0.85); // ~15% smaller
    doc.setTextColor(120);            // lighter grey
    doc.text(wrapped, x, specsY);

    // Restore
    doc.setTextColor(0, 0, 0);
    doc.setFontSize(prevSize);
  }
}); // <-- closes autoTable correctly

// ----- TOTAL (single line, aligned with table right edge) -----
const at = doc.lastAutoTable || null;
const totalsRightX = doc.internal.pageSize.getWidth() - margin;
let totalsY = (at?.finalY ?? (introY + 38)) + 22;

try {
  // Make sure a ₹-capable font is available (files must be in /public/fonts/)
  await loadRupeeFont(doc);
  doc.setFont("NotoSans", "bold");           // use the font that includes ₹
  doc.setFontSize(12);
  doc.setTextColor(0, 0, 0);
  // NOTE: a space after the ₹ avoids any accidental kerning issues
  doc.text(`Total: ₹ ${inr(cartSubtotal)}`, totalsRightX, totalsY, { align: "right" });
} catch (_e) {
  // Fallback if font couldn’t be fetched (offline etc.)
  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.setTextColor(0, 0, 0);
  doc.text(`Total: Rs ${inr(cartSubtotal)}`, totalsRightX, totalsY, { align: "right" });
} finally {
  // Restore default font for anything that follows
  doc.setFont("helvetica", "normal");
}

  // ----- TERMS & BANK -----
const ty = totalsY + 36; // <-- use totalsY so it stays below totals
doc.setFontSize(11);
doc.text("Terms & Conditions:", L, ty);

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
  ],
  L,
  ty + 16
);

// BANK DETAILS in bold
doc.setFont("helvetica", "bold");
doc.text("BANK DETAILS", L, ty + 120);

// back to normal font for bank info
doc.setFont("helvetica", "normal");
doc.text(
  [
    "HVF AGENCY",
    "ICICI BANK (Moran Branch)",
    "A/C No - 199505500412",
    "IFSC Code - ICIC0001995",
  ],
  L,
  ty + 136
);

  // open in new tab
  window.open(doc.output("bloburl"), "_blank");
};

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

    {/* top bar: Back button */}
    <div style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>
      <button
        onClick={backToCatalog}
        style={{
          padding: "6px 10px",
          borderRadius: 6,
          border: "1px solid #e5e7eb",
          background: "#f8f9fa",
          cursor: "pointer"
        }}
        aria-label="Back to product selection"
      >
        ← Back
      </button>
    </div>

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
    <th style={{ width: 40 }}></th> {/* Action */}
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
<td style={{ textAlign: "right", fontWeight: 700 }}>
  ₹{inr((r.qty || 0) * (r.unit || 0))}
</td>

{/* Action cell: small circular remove button */}
<td style={{ textAlign: "center" }}>
  <button
    onClick={() => removeRow(r.id)}
    title="Remove row"
    style={{
      width: 26,
      height: 26,
      borderRadius: "50%",
      border: "1px solid #ddd",
      background: "#fff",
      lineHeight: "24px",
      fontSize: 16,
      cursor: "pointer",
    }}
  >
    ×
  </button>
</td>
                  </tr>
                ))}
              </tbody>
</table>

{/* Action bar under table: Add Row on the left, totals on the right */}
<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 12 }}>
  <button onClick={addBlankRow}>+ Add Row</button>

  <div style={{ display: "flex", gap: 24 }}>
    <div>Subtotal <b>₹{inr(cartSubtotal)}</b></div>
    <div>Grand Total <b>₹{inr(cartSubtotal)}</b></div>
  </div>
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
        {quoteMode && (
  <button
    onClick={() => {
      loadSaved();
      document.getElementById("saved-pop").style.display = "block";
    }}
  >
    Saved Quotes
  </button>
)}
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