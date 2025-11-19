import React, { useLayoutEffect, useEffect, useMemo, useState, useRef } from "react";
import { createPortal } from "react-dom";
import { createClient } from "@supabase/supabase-js";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

// BodyPortal: safely render small overlays at <body> level
const BodyPortal = ({ children }) => {
  const elRef = useRef(null);
  if (!elRef.current) elRef.current = document.createElement("div");
  useEffect(() => {
    const el = elRef.current;
    document.body.appendChild(el);
    return () => { document.body.removeChild(el); };
  }, []);
  return createPortal(children, elRef.current);
};

// ---- PDF font loader (for ₹) ----
// We cache font data (base64) once, but ALWAYS register it on every new jsPDF doc.
let __rupeeFontCache = { regB64: null, boldB64: null };

function ab2b64(buf) {
  let binary = "";
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function loadRupeeFont(doc) {
  if (!__rupeeFontCache.regB64 || !__rupeeFontCache.boldB64) {
    const [regRes, boldRes] = await Promise.all([
      fetch("/fonts/NotoSans-Regular.ttf"),
      fetch("/fonts/NotoSans-Bold.ttf"),
    ]);
    const [regBuf, boldBuf] = await Promise.all([
      regRes.arrayBuffer(),
      boldRes.arrayBuffer(),
    ]);
    __rupeeFontCache.regB64 = ab2b64(regBuf);
    __rupeeFontCache.boldB64 = ab2b64(boldBuf);
  }

  // IMPORTANT: Register fonts on this jsPDF instance every time.
  doc.addFileToVFS("NotoSans-Regular.ttf", __rupeeFontCache.regB64);
  doc.addFont("NotoSans-Regular.ttf", "NotoSans", "normal");
  doc.addFileToVFS("NotoSans-Bold.ttf", __rupeeFontCache.boldB64);
  doc.addFont("NotoSans-Bold.ttf", "NotoSans", "bold");
}

/* --- Supabase client --- */
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: true, autoRefreshToken: true },
});

// Expose for browser-console diagnostics (safe in dev)
if (typeof window !== "undefined") {
  window.__supabase = supabase;
}

/* --- Helpers --- */
const forceTodayDate = (set) => {
  const t = todayStr();
  set((h) => (h?.date === t ? h : { ...h, date: t }));
};

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

// ---- helpers for editable quotation date ----
// Convert stored "dd/mm/yyyy" -> "yyyy-mm-dd" for <input type="date">
const headerDateToInput = (d) => {
  if (!d) return "";
  const parts = d.split("/");
  if (parts.length !== 3) return "";
  const [dd, mm, yyyy] = parts;
  return `${yyyy}-${mm}-${dd}`;
};

// Convert <input type="date" value "yyyy-mm-dd" -> "dd/mm/yyyy" for storage
const inputDateToHeader = (iso) => {
  if (!iso) return todayStr();
  const parts = iso.split("-");
  if (parts.length !== 3) return todayStr();
  const [yyyy, mm, dd] = parts;
  return `${dd}/${mm}/${yyyy}`;
};

// Today's date in "yyyy-mm-dd" format for max= on the date input
const todayISO = () => {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${yyyy}-${mm}-${dd}`;
};

const inferFirmFromNumber = (num) => {
  if (num == null || String(num).trim() === "") return "Internal";
  if (/^INT\//i.test(String(num))) return "Internal";               // ← NEW
  if (/^APP\/H\d{3}$/.test(num)) return "HVF Agency";
  if (/^APP\/VE\d{3}$/.test(num)) return "Victor Engineering";
  if (/^MH\d+$/.test(num)) return "Mahabir Hardware Stores";
  return null;
};

function numberMatchesFirm(firm, n) {
  // Internal quotes must never have a number
  if (firm === "Internal") return !n;
  if (!n) return false;
  if (firm === "HVF Agency") return /^APP\/H\d{3}$/.test(n);
  if (firm === "Victor Engineering") return /^APP\/VE\d{3}$/.test(n);
  if (firm === "Mahabir Hardware Stores") return /^MH\d+$/.test(n);
  return true;
}




// Per-firm next number via Supabase RPC (sequence + formatting)
async function getNextFirmQuoteNumber(firm) {
  const { data, error } = await supabase.rpc("next_quote_code", { p_firm: firm });
  if (error) throw error;
  return data; // e.g. "APP/H004", "VE001", "MH1052"
}

// (kept for save fallback if needed)
async function getNextQuoteCode(firmName) {
  const { data, error } = await supabase.rpc("next_quote_code", { p_firm: firmName });
  if (error) throw error;
  return data;
}

/* Legacy: Create APP/H### by counting existing quotes (fallback only) */
async function getNextQuoteNumber() {
  const { count, error } = await supabase
    .from("quotes")
    .select("*", { count: "exact", head: true });
  if (error) throw error;
  const next = (count || 0) + 1;
  return `APP/H${String(next).padStart(3, "0")}`;
}

/* ===== Persist quote UI state ===== */
const LS_KEY = "quoteState";
const loadQuoteState = () => {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || "{}");
  } catch {
    return {};
  }
};
const saveQuoteState = (s) => localStorage.setItem(LS_KEY, JSON.stringify(s));
/* ================================= */

/* --- App --- */
export default function App() {

  // MOBILE: lock viewport scaling to stop iOS auto-zoom on input focus (run before paint)
useLayoutEffect(() => {
  const base = 'width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover';
  // Only add interactive-widget on Chromium/Android (Safari logs a warning otherwise)
  const ua = navigator.userAgent || '';
  const addInteractive = /Android/i.test(ua) && /(Chrome|Edg)/i.test(ua);
  const content = addInteractive ? `${base}, interactive-widget=resizes-content` : base;

  // viewport
  let meta = document.querySelector('meta[name="viewport"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.setAttribute('name', 'viewport');
    document.head.appendChild(meta);
  }
  meta.setAttribute('content', content);

  // disable iOS phone-number auto-detection (prevents phone-number zoom/links)
  let fmt = document.querySelector('meta[name="format-detection"]');
  if (!fmt) {
    fmt = document.createElement('meta');
    fmt.setAttribute('name', 'format-detection');
    document.head.appendChild(fmt);
  }
  fmt.setAttribute('content', 'telephone=no');
}, []);

  /*** DATA ***/
  const [items, setItems] = useState([]);
  const [categories, setCategories] = useState([]);
  const [category, setCategory] = useState("All");
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");

  /*** AUTH / MENUS ***/
  const [session, setSession] = useState(null);
const [isAdmin, setIsAdmin] = useState(false);

// two-step local admin
const [adminEmail, setAdminEmail] = useState("");
const [adminPin, setAdminPin] = useState("");
const [adminStep, setAdminStep] = useState(null);

const [showLoginBox, setShowLoginBox] = useState(false);

// --- login menu refs & auto-close ---
const loginMenuRef = useRef(null);
const loginIdleTimer = useRef(null);
// categories strip ref (for auto-centering the active chip on mobile)
const catStripRef = useRef(null);

const closeLoginMenu = () => {
  if (loginIdleTimer.current) {
    clearTimeout(loginIdleTimer.current);
    loginIdleTimer.current = null;
  }
  if (loginMenuRef.current) {
    loginMenuRef.current.open = false; // closes the <details>
  }
};



  // staff quick view (PIN 2525)
  const [staffMode, setStaffMode] = useState(false);
  const toggleStaff = () => {
    if (staffMode) return setStaffMode(false);
    const pin = prompt("Enter staff PIN:");
    if ((pin || "").trim() === "2525") setStaffMode(true);
    else alert("Wrong PIN");
  };

  // quotation “cart” mode (PIN 9990)
  // seed from localStorage immediately so refresh doesn't reset UI
const __boot = (() => {
  try { return JSON.parse(localStorage.getItem("quoteState") || "{}"); }
  catch { return {}; }
})();

const [quoteMode, setQuoteMode] = useState(() => !!__boot.quoteMode); // true = show qty steppers on catalog
const [page, setPage] = useState(() => __boot.page || "catalog"); // "catalog" | "quoteEditor" | "savedDetailed"
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
    // ensure today's date is in the editor on mount too
    setQHeader((h) => ({ ...h, date: todayStr() }));

    function scheduleNextMidnight() {
      const now = new Date();
      const next = new Date(now);
      next.setDate(now.getDate() + 1);
      next.setHours(0, 0, 1, 0); // 00:00:01
      const ms = next.getTime() - now.getTime();

      const tid = setTimeout(() => {
        setQHeader((h) => ({ ...h, date: todayStr() }));
        scheduleNextMidnight();
      }, ms);

      return tid;
    }

    const timerId = scheduleNextMidnight();
    return () => clearTimeout(timerId);
  }, []);

  useEffect(() => {
  const init = async () => {
    const { data } = await supabase.auth.getSession();
    setSession(data.session ?? null);

    const adminPersist = localStorage.getItem("adminLogin") === "1";
    if (data.session?.user?.id) {
      const { data: prof } = await supabase
        .from("profiles")
        .select("is_admin")
        .eq("user_id", data.session.user.id)
        .maybeSingle();
      setIsAdmin(Boolean(prof?.is_admin) || adminPersist);
    } else {
      setIsAdmin(adminPersist);
    }
  };
  init();

  const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
    setSession(s);
    const adminPersist = localStorage.getItem("adminLogin") === "1";
    if (s?.user?.id) {
      supabase
        .from("profiles")
        .select("is_admin")
        .eq("user_id", s.user.id)
        .maybeSingle()
        .then(({ data }) => setIsAdmin(Boolean(data?.is_admin) || adminPersist));
    } else {
      setIsAdmin(adminPersist);
    }
    setShowLoginBox(false);
  });
  return () => sub.subscription.unsubscribe();
}, []);

  // --- Admin two-step (email -> PIN) ---
const ADMIN_EMAIL = "vic.ch25@icloud.com";
const ADMIN_PIN = "9957";

// --- passwordless sign-in via email link ---
const sendMagicLink = async () => {
  try {
    const { error } = await supabase.auth.signInWithOtp({
      email: ADMIN_EMAIL,
      options: { emailRedirectTo: window.location.origin }
    });
    if (error) throw error;
    alert("Magic link sent. Open it on this device and you’ll be signed in.");
  } catch (e) {
    alert(e?.message || "Could not send magic link");
  }
};

const startAdminFlow = () => {
  setShowLoginBox(true);
  setAdminStep("email");
  setAdminEmail("");
  setAdminPin("");
};

const verifyAdminEmail = () => {
  if ((adminEmail || "").trim().toLowerCase() === ADMIN_EMAIL) {
    setAdminStep("pin");
  } else {
    alert("Email not recognized.");
  }
};

const verifyAdminPin = () => {
  if ((adminPin || "").trim() === ADMIN_PIN) {
    setIsAdmin(true);
    localStorage.setItem("adminLogin", "1"); // persist until manual logout
    setShowLoginBox(false);
    setAdminStep(null);
    setAdminEmail("");
    setAdminPin("");
  } else {
    alert("Wrong PIN.");
  }
};

const signOut = async () => {
  // clear both Supabase session (if any) and local admin login
  try { await supabase.auth.signOut(); } catch {}
  localStorage.removeItem("adminLogin");
  setIsAdmin(false);
};

// Sign in with a magic link so Supabase gives us a real user session (auth.uid())
const magicLogin = async () => {
  const email = prompt("Enter your email to sign in:");
  if (!email) return;

  const { error } = await supabase.auth.signInWithOtp({
    email: email.trim(),
    options: { emailRedirectTo: window.location.origin }
  });

  if (error) return alert(error.message);
  alert("Magic link sent. Open it from your email, then return to this tab.");
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
    const { data } = await supabase
      .from("categories")
      .select("name")
      .order("name");
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

  // Center the active category chip on phones (on change, first load, and resize)
const centerActiveChip = () => {
  if (!catStripRef.current) return;
  if (window.innerWidth > 640) return; // mobile only
  const wrap = catStripRef.current;

  // wait for render/paint so widths are correct
  requestAnimationFrame(() => {
    const active = wrap.querySelector(".chip.active");
    if (!active) return;
    const left =
      active.offsetLeft - (wrap.clientWidth - active.clientWidth) / 2;
    wrap.scrollTo({ left: Math.max(0, left), behavior: "smooth" });
  });
};

// re-center when category changes AND when categories first populate
useEffect(() => {
  centerActiveChip();
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [category, categories.length]);

// also re-center on orientation/resize
useEffect(() => {
  const onResize = () => centerActiveChip();
  window.addEventListener("resize", onResize);
  return () => window.removeEventListener("resize", onResize);
}, []);

  /* ---------- ADMIN: ADD PRODUCT ---------- */
  const onChange = (e) => {
    const { name, value, files } = e.target;
    if (files) setForm((f) => ({ ...f, imageFile: files[0] || null }));
    else setForm((f) => ({ ...f, [name]: value }));
  };
  const onSave = async (e) => {
  e.preventDefault();
  if (!isAdmin) return alert("Admins only.");

  // Must be signed in to Supabase (RLS needs auth.uid())
  const { data: s } = await supabase.auth.getSession();
  if (!s?.session?.user?.id) {
    alert("Please use 'Sign in (email link)' first, then try again.");
    return;
  }

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
      const { error: insErr } = await supabase
        .from("machines")
        .insert(payload);
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
      alert(err.message);
    } finally {
      setSaving(false);
    }
  };

// === GST breakdown toggle (global; remembered across sessions) ===
const [gstBreakdown, setGstBreakdown] = useState(() => {
  try { return localStorage.getItem("hvf_gst_breakdown") === "1"; }
  catch { return false; }
});
useEffect(() => {
  try { localStorage.setItem("hvf_gst_breakdown", gstBreakdown ? "1" : "0"); }
  catch {}
}, [gstBreakdown]);


  /* ---------- QUOTE CART (works only in quoteMode on catalog) ---------- */
// Initialize from localStorage immediately so a refresh doesn't wipe items
const [cart, setCart] = useState(() => {
  try {
    return __boot.cart && typeof __boot.cart === "object" ? __boot.cart : {};
  } catch {
    return {};
  }
});
const cartList = Object.values(cart);
const cartCount = cartList.reduce((a, r) => a + (r.qty || 0), 0);
const cartSubtotal = cartList.reduce(
  (a, r) => a + (r.qty || 0) * (r.unit || 0),
  0
);

// --- GST breakdown derived data (rows + totals in one memo) ---
const gstCalc = useMemo(() => {
  if (!gstBreakdown) return { rows: [], totalIncl: 0, totalExcl: 0 };

  const rows = cartList.map((r, idx) => {
    const gst = Number.isFinite(r.gst) ? Number(r.gst) : 18; // % per row
    const qty = Number(r.qty || 0);
    const incl = Number(r.unit || 0);                        // you type inclusive price
    const excl = incl / (1 + gst / 100);                     // derived exclusive

    return {
      sl: idx + 1,
      name: r.name || "",
      specs: r.specs || "",
      gst,
      qty,
      rate_incl: incl,
      rate_excl: excl,
      total_incl: qty * incl,
      total_excl: qty * excl,
    };
  });

  const totalIncl = rows.reduce((s, x) => s + x.total_incl, 0);
  const totalExcl = rows.reduce((s, x) => s + x.total_excl, 0);

  return { rows, totalIncl, totalExcl };
}, [gstBreakdown, cartList]);
// Usage later: gstCalc.rows / gstCalc.totalIncl / gstCalc.totalExcl

  const inc = (m) =>
    setCart((c) => {
      const prev =
        c[m.id] || {
          id: m.id,
          name: m.name,
          specs: m.specs || "",
          unit: Number(m.mrp || 0),
          qty: 0,
        };
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
    const id = `custom-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 6)}`;
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

/* --- Smart PDF exporter (delegates to legacy layout) ---
   Always use legacy exportPDF() so header/footer/logo stay identical.
   Table differences are handled INSIDE exportPDF() using gstBreakdown. */
function exportPDFSmart() {
  try {
    if (typeof exportPDF === "function") {
      return exportPDF();
    }
    alert("PDF export unavailable (exportPDF not found)");
  } catch (e) {
    console.error("exportPDFSmart failed:", e);
    alert(`PDF export failed.\n${e?.message || e}`);
  }
}


  /* ---------- QUOTE EDITOR HEADER ---------- */
  const [qHeader, setQHeader] = useState({
    number: "",
    date: todayStr(),
    customer_name: "",
    address: "",
    phone: "",
    subject: "",
  });



const [editingQuoteId, setEditingQuoteId] = useState(null);

  const [firm, setFirm] = useState("HVF Agency");
const [savedOnce, setSavedOnce] = useState(false);



// marks that we loaded an existing, already-saved quote
const [loadedFromSaved, setLoadedFromSaved] = useState(false);

// prevent saving empties to localStorage before we've restored it once
const [hydrated, setHydrated] = useState(false);

  // --- Restore once from localStorage, then mark "hydrated" ---
useEffect(() => {
  try {
    const saved = loadQuoteState
      ? loadQuoteState()
      : JSON.parse(localStorage.getItem("quoteState") || "{}");

    if (saved && typeof saved === "object") {
      if (saved.cart) setCart(saved.cart);
      if (saved.qHeader) setQHeader(saved.qHeader);
      if (saved.page) setPage(saved.page);
      if (typeof saved.quoteMode === "boolean") setQuoteMode(saved.quoteMode);
      if (saved.firm) setFirm(saved.firm);
    }
  } catch (e) {
    console.error("Failed to restore quote state", e);
  } finally {
    setHydrated(true);
  }

  // keep date fresh; only updates if already different
  forceTodayDate(setQHeader);
}, []);

  // whenever cart, qHeader, page, quoteMode, or firm changes, save them
useEffect(() => {
  if (!hydrated) return; // don't overwrite before we've restored once
  saveQuoteState({ cart, qHeader, page, quoteMode, firm });
}, [hydrated, cart, qHeader, page, quoteMode, firm]);

// When the app lands on the Saved Detailed page (e.g. after a refresh),
// fetch the data and reset the firm filter to All.
// Also load delivered rows from Supabase so all devices stay in sync.
useEffect(() => {
  if (page === "savedDetailed") {
    setSavedFirmFilter("All");
    loadSavedDetailed();
    dbFetchDelivered(); // fire-and-forget; it updates deliveredRowsDB state
  }
}, [page]);

  // Ensure we have a firm-correct number, but do NOT reserve a new one
// if a valid number already exists in the editor state.
const ensureFirmNumber = async () => {
  // Internal quotes: never have a reference number
  if (firm === "Internal") {
    if (qHeader.number) setQHeader((h) => ({ ...h, number: "" }));
    return "";
  }

  const n = qHeader.number;

  // 1) If there is already a number and it matches this firm's format,
  //    just reuse it. Do NOT touch the counter.
  if (n && numberMatchesFirm(firm, n)) {
    return n;
  }

  // 2) Otherwise, reserve a NEW code from Supabase (text like "APP/H048")
try {
  const { data, error } = await supabase.rpc("next_quote_code", {
    p_firm: firm,
  });
  if (error || !data || String(data).trim() === "") {
    throw error || new Error("No code returned");
  }
  const today = todayStr();
setQHeader((h) => ({ ...h, number: String(data).trim(), date: today }));
setSavedOnce(false); // brand new code, not saved yet
return String(data).trim();
} catch (e) {
  console.error("Could not get next code from Supabase RPC:", e);
  alert("Could not fetch the next quotation code. Please check your internet and try again.");
  throw e;
}
};

// When firm changes, drop the existing number if it doesn't match the new firm's format.
// A fresh, firm-specific number will be pulled the next time you open the editor/print/save.
useEffect(() => {
  setQHeader((h) => {
    if (!h.number) return h; // nothing set yet
    if (numberMatchesFirm(firm, h.number)) return h; // already correct for this firm
    return { ...h, number: "" }; // clear so we fetch the right one on next action
  });
}, [firm]);

// Force-assign a brand-new code (always reserves next from DB)
const assignNewNumber = async () => {
  if (firm === "Internal") {
    setQHeader(h => ({ ...h, number: "" }));
    setSavedOnce(false);
    setEditingQuoteId(null);
    return;
  }
  try {
    const { data, error } = await supabase.rpc("next_quote_code", { p_firm: firm });
    if (error || !data || String(data).trim() === "") {
      throw error || new Error("No code returned");
    }
    const code = String(data).trim();
    setQHeader(h => ({ ...h, number: code, date: todayStr() }));
    // make sure we don’t “edit” an older row; saving should INSERT a new one
    setEditingQuoteId(null);
    setSavedOnce(false);
    return code;
  } catch (e) {
    console.error("Assign new code failed:", e);
    alert("Could not fetch a fresh quotation code. Please try again.");
    return null;
  }
};

// 4B: whenever the number changes, mark "not saved yet"
useEffect(() => {
  if (loadedFromSaved) {
    // keep it marked as saved for quotes loaded from DB
    setSavedOnce(true);
    setLoadedFromSaved(false);
    return;
  }
  // new number (reserved fresh) => not saved yet
  setSavedOnce(false);
}, [qHeader.number, loadedFromSaved]);
// 4B: also reset the flag when firm changes
useEffect(() => {
  setSavedOnce(false);
}, [firm]);
   


const startNewQuote = () => {
  setCart({});
  setQHeader({
    number: "",
    date: todayStr(),
    customer_name: "",
    address: "",
    phone: "",
    subject: "",
  });
setEditingQuoteId(null);
  setSavedOnce(false);
  setQuoteMode(true);
  setPage("catalog");
};

const goToEditor = async () => {
  if (cartList.length === 0) {
    alert("Add at least 1 item to the quote.");
    return;
  }

  // keep today's date fresh in the editor UI
  forceTodayDate(setQHeader);

  // Reserve/reuse a correct firm number for this session.
  // If a valid number is already present for the selected firm,
  // ensureFirmNumber will just reuse it (no counter increment).
  try {
    await ensureFirmNumber();
  } catch {
    // ensureFirmNumber already showed an alert; abort opening editor
    return;
  }

  // We’re not editing a saved row when coming from catalog
  setEditingQuoteId(null);
  setPage("quoteEditor");
};

  const backToCatalog = () => setPage("catalog");

// Ensure a clean, non-empty quotation code (string) everywhere we use it.
function normalizeQuoteCode(v) {
  const s = String(v ?? "").trim();
  if (!s) throw new Error("Quotation code/number is missing. Please assign a number first.");
  return s;
}

  /* ---------- SAVE USING YOUR SCHEMA (quotes + quote_items) ---------- */
const saveQuote = async (forceNumber) => {
  try {
    // INTERNAL: save with a hidden synthetic number so DB constraints are happy
if (firm === "Internal") {
  const syntheticNumber =
    `INT/${new Date().toISOString().slice(0,10).replace(/-/g,'')}/` +
    Math.random().toString(36).slice(2, 6).toUpperCase();

  const header = {
    number: syntheticNumber, // stored but never shown in UI
    customer_name: qHeader.customer_name || null,
    address: qHeader.address || null,
    phone: qHeader.phone || null,
    subject: qHeader.subject || null,
      total: cartSubtotal,
  firm,
};

      const { data: ins, error: insErr } = await supabase
        .from("quotes")
        .insert(header)
        .select("id")
        .single();
      if (insErr) throw insErr;
      const quoteId = ins.id;

      // Replace line items
      const rows = cartList.map((r) => ({
        quote_id: quoteId,
        name: r.name,
        specs: r.specs || null,
        qty: r.qty,
        mrp: r.unit,
      }));
      if (rows.length) {
        const { error: insI } = await supabase.from("quote_items").insert(rows);
        if (insI) throw insI;
      }

      // Editor state: keep number blank
      setSavedOnce(true);
      setEditingQuoteId(quoteId);

      alert(`Saved ✅ (Internal)`);
      return ""; // no number for internal
    }

    // NON-INTERNAL: ensure/get number then upsert on number
    const number = forceNumber ?? (await ensureFirmNumber());

// Ensure we never save empty/whitespace code
const code = normalizeQuoteCode(number);

const header = {
  number: code,
      customer_name: qHeader.customer_name || null,
      address: qHeader.address || null,
      phone: qHeader.phone || null,
      subject: qHeader.subject || null,
        total: cartSubtotal,
  firm,
};

    const { data: up, error: upErr } = await supabase
      .from("quotes")
      .upsert(header, { onConflict: "number" })
      .select("id,number")
      .single();

    if (upErr) throw upErr;
    const quoteId = up.id;

    // 4) Replace line items
    const rows = cartList.map((r) => ({
      quote_id: quoteId,
      name: r.name,
      specs: r.specs || null,
      qty: r.qty,
      mrp: r.unit,
    }));

    // delete old items then insert fresh
    const { error: delErr } = await supabase.from("quote_items").delete().eq("quote_id", quoteId);
    if (delErr) throw delErr;

    if (rows.length) {
      const { error: insErr } = await supabase.from("quote_items").insert(rows);
      if (insErr) throw insErr;
    }

    // 5) Sync editor state
    setQHeader((h) => ({ ...h, number: String(up?.number ?? code).trim() }));
    setSavedOnce(true);
    setEditingQuoteId(quoteId); // keep track we’re editing this row next time

    alert(`Saved ✅ (${up.number})`);
    return up.number;
  } catch (e) {
    console.error(e);
    alert("Save failed: " + (e?.message || e));
    return null;
  }
};

  /* ---------- LOAD SAVED LIST / EDIT / PDF ---------- */
const [saved, setSaved] = useState([]);
const [savedDetailed, setSavedDetailed] = useState([]);
const [deliveredDetailed, setDeliveredDetailed] = useState([]);
// Supabase-backed delivered lists
const [deliveredRowsDB, setDeliveredRowsDB] = useState([]);
const [deliveredIdsDB, setDeliveredIdsDB] = useState([]);
const [savedFirmFilter, setSavedFirmFilter] = useState(() => {
  try {
    const v = localStorage.getItem("hvf.savedFirm");
    const allowed = ["All", "HVF Agency", "Victor Engineering", "Mahabir Hardware Stores", "Internal"];
    return allowed.includes(v) ? v : "All";
  } catch {
    return "All";
  }
}); 



// "All" | "HVF Agency" | "Victor Engineering" | "Mahabir Hardware Stores"
const [savedSearch, setSavedSearch] = useState("");
const [onlySanctioned, setOnlySanctioned] = useState(false);

// --- One-time localStorage key migration (legacy -> new) ---
useEffect(() => {
  try {
    const legacy = localStorage.getItem("hvf.savedview");
    if (legacy && (legacy === "sanctioned" || legacy === "normal" || legacy === "delivered")) {
      localStorage.setItem("hvf.savedView", legacy);
      localStorage.removeItem("hvf.savedview");
    }
  } catch {}
}, []);

// NEW: separate page-mode inside Saved Detailed
const [savedView, setSavedView] = useState(() => {
  try {
    const v = localStorage.getItem("hvf.savedView");
    if (v === "sanctioned" || v === "delivered" || v === "normal") return v;
  } catch {}
  return "normal";
});

useEffect(() => {
  let mounted = true;
  (async () => {
    if (savedView !== "delivered") return;
    // try DB first
    const rows = await dbFetchDelivered();
    if (!mounted) return;
    if (Array.isArray(rows) && rows.length) {
      setDeliveredDetailed(rows);
      return;
    }
    // fallback to local storage if DB empty/unavailable
    try {
      const raw = localStorage.getItem("hvf.delivered");
      const arr = raw ? JSON.parse(raw) : [];
      setDeliveredDetailed(Array.isArray(arr) ? arr : []);
    } catch {
      setDeliveredDetailed([]);
    }
  })();
  return () => { mounted = false; };
}, [savedView]);

// Restore last firm tab ONLY when we are in normal view
useEffect(() => {
  if (savedView !== "normal") return;
  try {
    const f = localStorage.getItem("hvf.savedFirm");
    if (f) setSavedFirmFilter(f);
  } catch {}
}, [savedView]);

/* Persist Saved Detailed page-mode (normal / sanctioned / delivered) */
useEffect(() => {
  try {
    localStorage.setItem("hvf.savedView", savedView);
  } catch {}
}, [savedView]);

// Remember last firm tab when we enter Sanctioned view (HVF-only)
const lastFirmRef = useRef(null);

useEffect(() => {
  if (savedView === "sanctioned") {
    if (savedFirmFilter !== "HVF Agency") {
      lastFirmRef.current = savedFirmFilter;       // remember what user was viewing
      setSavedFirmFilter("HVF Agency");            // force HVF for sanctioned table
    }
  } else if (savedView === "normal" && lastFirmRef.current) {
    setSavedFirmFilter(lastFirmRef.current);       // restore previous firm tab
    lastFirmRef.current = null;
  }
}, [savedView]); // runs when the Sanctioned button toggles

// Restore last firm tab (only used for normal view)
useEffect(() => {
  try {
    const f = localStorage.getItem("hvf.savedFirm");
    if (f) setSavedFirmFilter(f);
  } catch {}
}, []);

// Persist firm tab changes (only when not in sanctioned view)
useEffect(() => {
  if (savedView === "normal") {
    try { localStorage.setItem("hvf.savedFirm", savedFirmFilter); } catch {}
  }
}, [savedFirmFilter, savedView]);

// Persist savedView to localStorage whenever it changes
useEffect(() => {
  try {
    localStorage.setItem("hvf.savedView", savedView);
  } catch {}
}, [savedView]);




// Inline edit pills for CSM & RTNAD (sanctioned table only)
const [editingCSM, setEditingCSM] = useState({ id: null, value: "" });     // {id, value}
const [editingRTNAD, setEditingRTNAD] = useState({ id: null, value: "" }); // {id, value}
const [savingInline, setSavingInline] = useState(false);


// Small anchored popover for setting "Status" (full/partial)
const [statusPop, setStatusPop] = useState({ open: false, row: null, x: 0, y: 0 });

// Tiny anchored popovers for the CSM / RTNAD pills
const [csmPop, setCSMPop] = useState({ open: false, row: null, x: 0, y: 0 });
const [rtnadPop, setRTNADPop] = useState({ open: false, row: null, x: 0, y: 0 });

// --- helpers: open & place the small pill popovers without scrolling ---
const placeTinyPopover = (evt, row, setPop) => {
  const pill = evt?.currentTarget;
  if (!pill) return;

  const r = pill.getBoundingClientRect();

  // Default position: centered under the pill
  const POPOVER_W = 220; // must match the pop width we’ll render
  const POPOVER_H = 90;  // approx height for input + 2 buttons
  const pad = 12;

  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let x = r.left + r.width / 2;      // center horizontally on pill
  let y = r.bottom + 8;              // show below by default

  // keep horizontally inside viewport
  const minX = pad + POPOVER_W / 2;
  const maxX = vw - pad - POPOVER_W / 2;
  x = Math.max(minX, Math.min(maxX, x));

  // if bottom overflows, flip above
  if (r.bottom + 8 + POPOVER_H > vh) {
    y = r.top - 8; // we’ll render with translateY(-100%) so this sits above
  }

  setPop({ open: true, row, x, y });
};

const openCSMPop = (row, evt) => {
  // only one editor at a time
  setEditingRTNAD({ id: null, value: "" });
  setEditingCSM({ id: row.id, value: row?.csm_amount ?? "" });
  placeTinyPopover(evt, row, setCSMPop);
  // focus the input after popover mounts
  setTimeout(() => {
    const el = document.getElementById(`csm-input-${row.id}`);
    if (el) el.focus();
  }, 0);
};

const openRTNADPop = (row, evt) => {
  setEditingCSM({ id: null, value: "" });
  setEditingRTNAD({ id: row.id, value: row?.rtnad_amount ?? "" });
  placeTinyPopover(evt, row, setRTNADPop);
  // focus the input after popover mounts
  setTimeout(() => {
    const el = document.getElementById(`rtnad-input-${row.id}`);
    if (el) el.focus();
  }, 0);
};

const closePillPops = () => {
  setCSMPop(p => ({ ...p, open: false }));
  setRTNADPop(p => ({ ...p, open: false }));
};

const [statusForm, setStatusForm] = useState({
  date: new Date().toISOString().slice(0,10), // yyyy-mm-dd
  mode: "full",                                // "full" | "partial"
  amount: "",                                  // used only if partial
});
const [statusErr, setStatusErr] = useState("");
const [savingStatus, setSavingStatus] = useState(false);
// three-dots per-row menu (sanctioned view only)
const [rowMenuId, setRowMenuId] = useState(null);

// live position of the floating menu (viewport-safe)
const [rowMenuPos, setRowMenuPos] = useState({ x: 0, y: 0, above: false, w: 220, h: 156 });

const [deliverPop, setDeliverPop] = useState({ open: false, row: null });

// --- Deliver modal state (large dialog) ---
/** Form snapshot for the Deliver popup */
// Build a clean payload from the deliver form + current row and stash in localStorage for now.
// We'll hook Supabase + Delivered tab in the next step.
const saveDeliverLocal_OLD = () => {

const saveDeliverLocal = async () => {
  try {
    const row = deliverPop?.row;
    if (!row) return;

    // 1) Track delivered IDs so the row disappears from Sanctioned view
    const deliveredIds = (() => {
      try { return JSON.parse(localStorage.getItem("hvf.deliveredIds") || "[]"); }
      catch { return []; }
    })();
    if (!deliveredIds.includes(row.id)) deliveredIds.push(row.id);
    localStorage.setItem("hvf.deliveredIds", JSON.stringify(deliveredIds));

    // 2) Store full Delivered record (for the separate Delivered list)
    const deliveredList = (() => {
      try { return JSON.parse(localStorage.getItem("hvf.deliveredList") || "[]"); }
      catch { return []; }
    })();

    const rec = {
      id: row.id,
      number: row.number || row.quotation_no || row.quote_no || "",
      firm: row.firm || inferFirmFromNumber(row.number || row.quotation_no || ""),
      customer_name: row.customer_name || "",
      total: Number(row.total || 0),

      // from the dialog
      date: deliverForm.date || new Date().toISOString().slice(0,10),
      sanctioned: deliverForm.sanctioned ?? "",
      csm: deliverForm.csm ?? "",
      rtnad: deliverForm.rtnad ?? "",
      items: Array.isArray(deliverForm.items)
        ? deliverForm.items
            .filter(it => !!it.delivered)
            .map(it => (it?.name || "").trim())
            .filter(Boolean)
        : [],
        adjust: deliverForm.adjust || "",

  // amounts collected from dialog (strip ₹ and commas)
  sanctioned_amount: (() => {
    const v = (deliverForm.sanctioned ?? "").toString().replace(/[^0-9.]/g, "");
    return v ? Number(v) : null;
  })(),
  csm_amount: (() => {
    const v = (deliverForm.csm ?? "").toString().replace(/[^0-9.]/g, "");
    return v ? Number(v) : null;
  })(),
  rtnad_amount: (() => {
    const v = (deliverForm.rtnad ?? "").toString().replace(/[^0-9.]/g, "");
    return v ? Number(v) : null;
  })(),

  // mode (full/partial) if present on form; fallback to existing row value
  sanctioned_mode: (deliverForm.mode || deliverForm.sanctioned_mode || row.sanctioned_mode || ""),
};

    const idx = deliveredList.findIndex(r => r.id === rec.id);
    if (idx === -1) deliveredList.push(rec); else deliveredList[idx] = rec;

    localStorage.setItem("hvf.deliveredList", JSON.stringify(deliveredList));

// Write to Supabase and refresh Delivered from DB
try {
  const quoteId = row?.id || row?.quote_id;
  if (quoteId) {
    await dbUpsertDelivered(quoteId, rec);
    await dbFetchDelivered();
  }
} catch (e) {
  console.error("dbUpsertDelivered error:", e);
}

    // 3) Close and refresh
    setDeliverPop({ open: false, row: null });
setSavedView("delivered");
try { localStorage.setItem("hvf.savedView", "delivered"); } catch {}
    await (typeof loadSavedDetailed === "function" ? loadSavedDetailed() : Promise.resolve());
  } catch (e) {
    alert(e?.message || "Could not save Delivered entry.");
  }
};

  const row = deliverPop?.row;
  if (!row) return;

  const today = new Date().toISOString().slice(0,10);

  // keep only ticked items, trim names
  const picked = (deliverForm.items || [])
    .filter(it => it?.delivered)
    .map(it => (it?.name || "").trim())
    .filter(Boolean);

  const record = {
    id: row.id,                               // quote id
    quotation_no: row.quotation_no || "",     // for quick reference
    customer: row.customer || "",
    firm: row.firm || "",
    delivered_date: deliverForm.date || today,
    items_delivered: picked,                  // array of strings
    sanctioned_shown: deliverForm.sanctioned ?? "",
    csm_amount: deliverForm.csm ?? "",
    rtnad_amount: deliverForm.rtnad ?? "",
    remarks: deliverForm.adjust ?? "",
    // useful originals to show later
    total: row.total ?? "",
    sanctioned_mode: row.sanctioned_mode || "",
  };

  // persist to a simple local list for now
  let arr = [];
  try { arr = JSON.parse(localStorage.getItem("hvf.delivered") || "[]"); } catch {}
  arr.push(record);
  localStorage.setItem("hvf.delivered", JSON.stringify(arr));
try { localStorage.setItem("hvf_delivered", JSON.stringify(arr)); } catch {}

  // also remember this id as delivered (so we can hide it from Sanctioned in UI next)
  let deliveredIds = [];
  try { deliveredIds = JSON.parse(localStorage.getItem("hvf.deliveredIds") || "[]"); } catch {}
  if (!deliveredIds.includes(row.id)) deliveredIds.push(row.id);
  localStorage.setItem("hvf.deliveredIds", JSON.stringify(deliveredIds));

  // close dialog for now
  setDeliverPop({ open: false, row: null });

  // temporary feedback
  console.log("✔ Saved delivered locally:", record);
};

const [deliverForm, setDeliverForm] = useState({
  date: "",            // ISO yyyy-mm-dd (we’ll default to today)
  items: [],           // [{ name, delivered }]
  sanctioned: "",      // shown amount (full/partial)
  csm: "",             // editable CSM amount
  rtnad: "",           // editable RTNAD amount
  adjust: ""           // optional remarks / adjustments
});



// Open the Deliver dialog with sensible defaults
const openDeliver = (row) => {
  if (!row) return;
  // Build editable items list (default: all ticked)
  const names = Array.isArray(row?.quote_items) ? row.quote_items.map(it => it?.name).filter(Boolean) : [];
  const items = names.map(n => ({ name: n, delivered: true }));

  // Compute sanctioned shown amount (same display logic as table)
  const mode = (row?.sanctioned_mode || "full").toLowerCase();
  const sanctionedShown = mode === "partial"
    ? Number(row?.sanctioned_amount || 0)
    : Number(row?.total || 0);

  setDeliverForm({
    date: todayStr(),
    items,
    sanctioned: Number.isFinite(sanctionedShown) ? String(sanctionedShown) : "",
    csm: row?.csm_amount != null ? String(row.csm_amount) : "",
    rtnad: row?.rtnad_amount != null ? String(row.rtnad_amount) : "",
    adjust: ""
  });
  setDeliverPop({ open: true, row });
};

// --- Deliver form handlers ---
const onDeliverField = (key) => (e) =>
  setDeliverForm((f) => ({ ...f, [key]: e.target.value }));

const onToggleItem = (idx) => (e) =>
  setDeliverForm((f) => ({
    ...f,
    items: f.items.map((it, i) =>
      i === idx ? { ...it, delivered: e.target.checked } : it
    ),
  }));

const onRemoveItem = (idx) =>
  setDeliverForm((f) => ({
    ...f,
    items: f.items.filter((_, i) => i !== idx),
  }));

const saveDeliver = async () => {
  // temporary: just log & close (we'll persist and move rows in the next step)
  console.log("DELIVER SAVE", { row: deliverRow, form: deliverForm });
  setDeliverOpen(false);
};

const closeDeliver = () => setDeliverPop({ open: false, row: null });

/** Open the ⋯ menu and place it so it never overflows the viewport.
 *  Works only for Sanctioned View.
 */


const openRowMenu = (row, evt) => {
  // estimated size of the menu (will fit 3–5 items)
  const MENU_W = 220;
  const MENU_H = 208; // fits 4 items comfortably

  const btn = evt.currentTarget;
  const r = btn.getBoundingClientRect();           // button position in viewport
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const scrollX = window.scrollX || window.pageXOffset;
  const scrollY = window.scrollY || window.pageYOffset;

  // horizontal: prefer right-align to the trigger, but keep inside viewport
  let left = r.right - MENU_W;                     // right-align to button
  left = Math.max(12, Math.min(left, vw - MENU_W - 12)) + scrollX;

  // vertical: if not enough room below, flip above
  const spaceBelow = vh - r.bottom;
  const needFlip = spaceBelow < (MENU_H + 12);
  let top = needFlip ? (r.top - MENU_H - 8) : (r.bottom + 8);
  // keep a small inset from the edges
  if (top < 12) top = 12;
  if (top > vh - MENU_H - 12) top = vh - MENU_H - 12;
  top += scrollY;

  setRowMenuId(row.id);
  setRowMenuPos({ x: left, y: top, above: needFlip, w: MENU_W, h: MENU_H });
};




// close menus / mini popovers on outside click or Esc
useEffect(() => {
  const onDocClick = (e) => {
    const isRowMenu  = e.target.closest('.row-menu') || e.target.closest('.row-menu-btn');
    const isPillArea = e.target.closest('.pill-pop')  || e.target.closest('.pill-btn');

    if (!isRowMenu) setRowMenuId(null);

    if (!isPillArea) {
      if (editingCSM.id != null)   setEditingCSM({ id: null, value: "" });
      if (editingRTNAD.id != null) setEditingRTNAD({ id: null, value: "" });
      closePillPops();
    }
  };

  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      setRowMenuId(null);
      if (editingCSM.id != null)   setEditingCSM({ id: null, value: "" });
      if (editingRTNAD.id != null) setEditingRTNAD({ id: null, value: "" });
      closePillPops();
    }
  };

  document.addEventListener('click', onDocClick);
  document.addEventListener('keydown', onKeyDown);
  return () => {
    document.removeEventListener('click', onDocClick);
    document.removeEventListener('keydown', onKeyDown);
  };
}, [editingCSM.id, editingRTNAD.id]);



const openStatus = (row, evt) => {
  const r = evt.currentTarget.getBoundingClientRect();
  setStatusPop({
    open: true,
    row,
    x: r.left + window.scrollX,
    y: r.bottom + window.scrollY,
  });
  setStatusForm({ date: new Date().toISOString().slice(0,10), mode: "full", amount: "" });
  setStatusErr("");
};

const closeStatus = () => setStatusPop({ open: false, row: null, x: 0, y: 0 });

const saveStatus = async () => {
  setStatusErr("");

  if (!statusPop?.row?.id) { setStatusErr("Invalid quote"); return; }
takeSnapshot("Sanction");

  const isPartial = statusForm.mode === "partial";
  let amt = null;

  if (isPartial) {
    const n = Number(statusForm.amount);
    if (!Number.isFinite(n) || n <= 0) {
      setStatusErr("Enter valid amount");
      return;
    }
    amt = n;
  } else {
    // FULL: you asked to auto-select the total — we store null for full,
    // but UI computes/uses the row total; nothing to type.
    amt = null;
  }

  const d = (statusForm.date || "").trim();
  if (!d) { setStatusErr("Date is required"); return; }

// snapshot BEFORE mutating status (enables global Undo)
takeSnapshot(`status:${statusPop?.row?.number || statusPop?.row?.id || ""}`);

  setSavingStatus(true);
  try {
    const payload = {
      sanctioned_status: "sanctioned",
      sanctioned_mode: statusForm.mode,   // "full" | "partial"
      sanctioned_date: d,                 // yyyy-mm-dd
      sanctioned_amount: amt,             // null for full
    };

    const { error } = await supabase
      .from("quotes")
      .update(payload)
      .eq("id", statusPop.row.id);

    if (error) throw error;

    alert("Status saved ✅");
    await loadSavedDetailed(); // refresh the table
    closeStatus();
  } catch (e) {
    console.error(e);
    setStatusErr(e?.message || "Could not save. Try again");
  } finally {
    setSavingStatus(false);
  }
};

// === Undo Sanction: remove sanctioned fields and refresh UI ===
async function clearSanctionById(quoteId) {
  try {
    if (!quoteId) return;

    // 1) DB: clear sanction fields
    const { error } = await supabase
      .from("quotes")
      .update({
        sanctioned_status: null,
        sanctioned_date: null,
        sanctioned_mode: null,
        sanctioned_amount: null,
      })
      .eq("id", quoteId);

    if (error) throw error;

    // 2) Refresh HVF/All rows
    if (typeof loadSavedDetailed === "function") {
      await loadSavedDetailed();
    }

    // 3) Ensure we’re on the normal list view (optional, keeps UI consistent)
try { localStorage.setItem("hvf.savedView", "normal"); } catch {}
    if (typeof setSavedView === "function") setSavedView("normal");
  } catch (e) {
    console.warn("clearSanctionById failed:", e);
    alert(e?.message || "Could not undo sanction. Please try again.");
  }
}

const saveCSM = async (rowId) => {
  const raw = (editingCSM.value || "").trim();
  const num = raw === "" ? null : Number(raw);
  if (raw !== "" && (!Number.isFinite(num) || num < 0)) {
    alert("Enter a valid non-negative CSM amount.");
    return;
  }
  setSavingInline(true);
  try {
    const { error } = await supabase
      .from("quotes")
      .update({ csm_amount: num })
      .eq("id", rowId);
    if (error) throw error;
    await loadSavedDetailed();
setEditingCSM({ id: null, value: "" });
setCSMPop(p => ({ ...p, open: false }));
  } catch (e) {
    alert(e?.message || "Could not save CSM.");
  } finally {
    setSavingInline(false);
  }
};

// Keyboard helpers so Enter=OK, Esc=Cancel
const handleInlineKeyCSM = (e, rowId) => {
  if (e.key === "Enter") { e.preventDefault(); saveCSM(rowId); return; }
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    setEditingCSM({ id: null, value: "" });
    setCSMPop(p => ({ ...p, open: false }));
  }
};
const handleInlineKeyRTNAD = (e, rowId) => {
  if (e.key === "Enter") { e.preventDefault(); saveRTNAD(rowId); return; }
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    setEditingRTNAD({ id: null, value: "" });
    setRTNADPop(p => ({ ...p, open: false }));
  }
};



const saveRTNAD = async (rowId) => {
  const raw = (editingRTNAD.value || "").trim();
  const num = raw === "" ? null : Number(raw);
  if (raw !== "" && (!Number.isFinite(num) || num < 0)) {
    alert("Enter a valid non-negative RTNAD amount.");
    return;
  }
  setSavingInline(true);
  try {
    const { error } = await supabase
      .from("quotes")
      .update({ rtnad_amount: num })
      .eq("id", rowId);
    if (error) throw error;
    await loadSavedDetailed();
setEditingRTNAD({ id: null, value: "" });
setRTNADPop(p => ({ ...p, open: false }));
  } catch (e) {
    alert(e?.message || "Could not save RTNAD.");
  } finally {
    setSavingInline(false);
  }
};

// remove sanctioned status for a quote (used by 'Undo' in sanctioned list)
const unsanctionRow = async (rowId) => {
  if (!rowId) return;
  if (!confirm("Remove sanctioned status for this quote?")) return;

  setSavingInline?.(true); // ok if you already have this state; otherwise remove this line
  try {
    // clear sanctioned fields so the row becomes "normal" again
    const payload = {
      sanctioned_status: null,
      sanctioned_mode: null,
      sanctioned_date: null,
      sanctioned_amount: null,
    };

    const { error } = await supabase
      .from("quotes")
      .update(payload)
      .eq("id", rowId);

    if (error) throw error;

    // refresh the table so the chips disappear and Status becomes usable again
    await loadSavedDetailed?.();
  } catch (e) {
    alert(e?.message || "Could not undo sanctioned status.");
  } finally {
    try { setSavingInline?.(false); } catch {}
  }
};

// --- tiny pill render helpers for CSM / RTNAD (click -> anchored popover) ---
const renderMoney = (v) => {
  if (v === null || v === undefined || v === "") return "Set";
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  // simple INR formatting without relying on external libs
  return "₹" + n.toLocaleString("en-IN");
};

const renderCSMPill = (row) => (
  <span className="pill-edit-wrap" data-row-id={row.id} style={{ display: "inline-block" }}>
    <button
  type="button"
  className="pill-btn"
  onClick={(e) => openCSMPop(row, e)}
  onKeyDown={(e) => {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      openCSMPop(row, e);
    }
  }}
  title="Edit CSM amount"
  aria-haspopup="dialog"
  aria-expanded={editingCSM.id === row.id}
  aria-controls={`csm-pop-${row.id}`}
  style={{
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    height: 28,
    padding: "0 10px",
    borderRadius: 999,
    border: "1px solid rgba(0,0,0,.18)",
    background: "#fff",
    cursor: "pointer",
    whiteSpace: "nowrap",
    maxWidth: 180,
    overflow: "hidden",
    textOverflow: "ellipsis",
    verticalAlign: "middle"
  }}
>
      <span style={{
        width: 8, height: 8, borderRadius: 999, background: "currentColor", opacity: 0.65
      }} />
      <span>CSM:</span>
      <strong>{renderMoney(row?.csm_amount)}</strong>
    </button>
  </span>
);

const renderRTNADPill = (row) => (
  <span className="pill-edit-wrap" data-row-id={row.id} style={{ display: "inline-block" }}>
    <button
  type="button"
  className="pill-btn"
  onClick={(e) => openRTNADPop(row, e)}
  onKeyDown={(e) => {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      openRTNADPop(row, e);
    }
  }}
  title="Edit RTNAD amount"
  aria-haspopup="dialog"
  aria-expanded={editingRTNAD.id === row.id}
  aria-controls={`rtnad-pop-${row.id}`}
  style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        height: 28,
        padding: "0 10px",
        borderRadius: 999,
        border: "1px solid rgba(0,0,0,.18)",
        background: "#fff",
        cursor: "pointer",
        whiteSpace: "nowrap",
        maxWidth: 180,
        overflow: "hidden",
        textOverflow: "ellipsis",
        verticalAlign: "middle"
      }}
    >
      <span style={{
        width: 8, height: 8, borderRadius: 999, background: "currentColor", opacity: 0.65
      }} />
      <span>RTNAD:</span>
      <strong>{renderMoney(row?.rtnad_amount)}</strong>
    </button>
  </span>
);

// Unsanction (Sanctioned View only): clear sanctioned fields so it moves back to HVF normal list
const unsanctionQuote = async (row) => {
  if (!row?.id) return;
  const ok = confirm(`Remove ${row.number || "this quote"} from Sanctioned?`);
  if (!ok) return;

  try {
    const { error } = await supabase
      .from("quotes")
      .update({
        sanctioned_status: null,
        sanctioned_mode: null,
        sanctioned_date: null,
        sanctioned_amount: null,
      })
      .eq("id", row.id);

    if (error) throw error;

    alert("Removed from Sanctioned ✅");
    // refresh list and close the menu
    await loadSavedDetailed();
    setRowMenuId(null);
  } catch (e) {
    console.error(e);
    alert(e?.message || "Could not remove from Sanctioned.");
  }
};

// Format ISO date to DD/MM/YYYY
const fmtDate = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
};

// Pretty badge for the "Sanctioned Amount" cell (stacked; no date)
function renderSanctionBadge(q) {
  try {
    const mode = (q?.sanctioned_mode || "full").toLowerCase(); // "full" | "partial"
    const isPartial = mode === "partial";
    const amt = isPartial ? Number(q?.sanctioned_amount || 0) : Number(q?.total || 0);
    const show = Number.isFinite(amt) ? `₹${inr(amt)}` : "—";

    const pillStyle = {
      padding: "2px 8px",
      borderRadius: 999,
      border: isPartial ? "1px solid #ffd9b0" : "1px solid #b7e7c2",
      background: isPartial ? "#fff7ec" : "#eefcf1",
      fontWeight: 700,
      fontSize: 12,
      display: "inline-block"
    };

    return (
      <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}>
        <span style={pillStyle}>{isPartial ? "Partial" : "Full"}</span>
        <span style={{ fontWeight: 700 }}>{show}</span>
      </span>
    );
  } catch {
    const amt = Number(q?.sanctioned_amount ?? q?.total ?? 0);
    const show = Number.isFinite(amt) ? `₹${inr(amt)}` : "—";
    return <span style={{ fontWeight: 700 }}>{show}</span>;
  }
}

// --- Tiny toggle switch component (used for GST breakdown) ---
function Toggle({ checked, onChange, label }) {
  return (
    <label style={{ display: "inline-flex", alignItems: "center", gap: 8, cursor: "pointer", userSelect: "none" }}>
      <span style={{ fontSize: 13, color: "#374151" }}>{label}</span>
      <span
        onClick={() => onChange(!checked)}
        role="switch"
        aria-checked={checked}
        style={{
          width: 42, height: 24, borderRadius: 999,
          background: checked ? "#16a34a" : "#e5e7eb",
          position: "relative", transition: "background 120ms ease"
        }}
      >
        <span
          style={{
            position: "absolute",
            top: 2, left: checked ? 20 : 2,
            width: 20, height: 20, borderRadius: "50%",
            background: "#fff", boxShadow: "0 1px 2px rgba(0,0,0,.25)",
            transition: "left 120ms ease"
          }}
        />
      </span>
    </label>
  );
}


/* 👇 PASTE THE BELOW CODE RIGHT AFTER THE TOGGLE COMPONENT */

// --- GST rate cell (used in editor table when GST breakdown is ON) ---
function GSTRateCell({ id, value, onChange }) {
  // value = current GST percentage for this row
  const isPreset = value === 5 || value === 18;
  const selectValue = isPreset ? String(value) : "custom";

  const handleSelect = (e) => {
    const v = e.target.value;
    if (v === "5") onChange(5);
    else if (v === "18") onChange(18);
    else onChange(Number.isFinite(value) ? value : 0); // switch to custom, keep or default 0
  };

  const handleCustom = (e) => {
    const txt = e.target.value.trim();
    if (txt === "" || txt === ".") {
      onChange(NaN);
      return;
    }
    const n = Number(txt);
    onChange(Number.isFinite(n) ? n : 0);
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 120 }}>
      <select value={selectValue} onChange={handleSelect}>
        <option value="5">5%</option>
        <option value="18">18%</option>
        <option value="custom">Custom…</option>
      </select>
      {selectValue === "custom" && (
        <input
          type="number"
          inputMode="decimal"
          step="0.01"
          min="0"
          placeholder="GST %"
          value={Number.isFinite(value) ? String(value) : ""}
          onChange={handleCustom}
          style={{ width: 80 }}
        />
      )}
    </div>
  );
}

// computed list used by the Detailed page table (respects firm tab + search box) — SAFE
const savedDetailedFiltered = useMemo(() => {
  const list = Array.isArray(savedDetailed) ? savedDetailed : [];


  // firm tab filter
  const byFirm =
    savedFirmFilter === "All"
      ? list.filter((q) => inferFirmFromNumber(q?.number) !== "Internal") // exclude internal from "All"
      : list.filter(
          (q) => (inferFirmFromNumber(q?.number) || "") === savedFirmFilter
        );

  // Apply status filtering when in "sanctioned" view (HVF only)
const byStatus =
  savedView === "sanctioned"
    ? byFirm.filter(
        (q) =>
          (inferFirmFromNumber(q?.number) || "") === "HVF Agency" &&
          (q?.sanctioned_status || "") === "sanctioned"
      )
    : byFirm;

const q = (savedSearch || "").trim().toLowerCase();
if (!q) return byStatus;

  // helper to stringify safely
  const text = (v) => (v == null ? "" : String(v));

  return byStatus.filter((row) => {
    try {
      const parts = [];

      // number, date
      parts.push(text(row?.number));
      const dateStr = row?.created_at ? text(fmtDate(row.created_at)) : "";
      parts.push(dateStr);

      // customer fields
      parts.push(text(row?.customer_name), text(row?.address), text(row?.phone));

      // item names
      const itemNames = Array.isArray(row?.quote_items)
        ? row.quote_items.map((it) => text(it?.name)).join(" ")
        : "";
      parts.push(itemNames);

      // totals (raw and formatted)
      const totalNum = Number(row?.total ?? 0);
      if (Number.isFinite(totalNum)) {
        parts.push(String(totalNum), text(inr(totalNum)), `₹${text(inr(totalNum))}`);
      }

      const hay = parts.join(" ").toLowerCase();
      return hay.includes(q);
    } catch {
      return true;
    }
  });
}, [savedDetailed, savedFirmFilter, savedSearch, onlySanctioned, savedView]);

// ---- Separate dataset for the "Sanctioned View" (same firm tabs + search, but only sanctioned) ----
const sanctionedDetailedFiltered = useMemo(() => {
  const list = Array.isArray(savedDetailed) ? savedDetailed : [];

  // mirror firm-tab behavior of the normal view
  const byFirm =
    savedFirmFilter === "All"
      ? list.filter((q) => inferFirmFromNumber(q?.number) !== "Internal") // exclude Internal in All
      : list.filter(
          (q) => (inferFirmFromNumber(q?.number) || "") === savedFirmFilter
        );

// keep only sanctioned, then sort by sanctioned_date (newest first)
const only = byFirm
  .filter((q) => (q.sanctioned_status || "") === "sanctioned");

const sorted = [...only].sort((a, b) => {
  const ta = a.sanctioned_date ? new Date(a.sanctioned_date).getTime() : 0;
  const tb = b.sanctioned_date ? new Date(b.sanctioned_date).getTime() : 0;
  if (tb !== ta) return tb - ta; // primary: sanctioned_date (newest first)

  const ca = a.created_at ? new Date(a.created_at).getTime() : 0;
  const cb = b.created_at ? new Date(b.created_at).getTime() : 0;
  return cb - ca;               // secondary: created_at (newest first)
});

  // search (same as normal)
  const q = (savedSearch || "").trim().toLowerCase();
  if (!q) return sorted;

  const text = (v) => (v == null ? "" : String(v));
  return sorted.filter((row) => {
    try {
      const parts = [];
      parts.push(text(row?.number));
      const dateStr = row?.created_at ? text(fmtDate(row.created_at)) : "";
      parts.push(dateStr);
      parts.push(text(row?.customer_name), text(row?.address), text(row?.phone));
      const itemNames = Array.isArray(row?.quote_items)
        ? row.quote_items.map((it) => text(it?.name)).join(" ")
        : "";
      parts.push(itemNames);
      const totalNum = Number(row?.total ?? 0);
      if (Number.isFinite(totalNum)) {
        parts.push(String(totalNum), text(inr(totalNum)), `₹${text(inr(totalNum))}`);
      }
      return parts.join(" ").toLowerCase().includes(q);
    } catch {
      return true;
    }
  });
}, [savedDetailed, savedFirmFilter, savedSearch]);

// Compact stats for the Sanctioned View chip
const sanctionedStats = useMemo(() => {
  if (savedView !== "sanctioned") return null;
  const rows = Array.isArray(sanctionedDetailedFiltered) ? sanctionedDetailedFiltered : [];

  let full = 0, partial = 0;
  let amtFull = 0, amtPartial = 0;

  for (const q of rows) {
    const mode = (q.sanctioned_mode || "full").toLowerCase();
    if (mode === "partial") {
      partial += 1;
      const n = Number(q.sanctioned_amount || 0);
      if (Number.isFinite(n)) amtPartial += n;
    } else {
      full += 1;
      const n = Number(q.total || 0);
      if (Number.isFinite(n)) amtFull += n;
    }
  }

  return {
    count: rows.length,
    full,
    partial,
    amtFull,
    amtPartial,
    grand: amtFull + amtPartial,
  };
}, [savedView, sanctionedDetailedFiltered]);

// Which dataset should the table show?
const tableData =
  savedView === "sanctioned" ? sanctionedDetailedFiltered : savedDetailedFiltered;

const emptyMsg =
  savedView === "sanctioned"
    ? "No sanctioned quotations found."
    : "No saved quotations found.";

// Fetch the list of saved quotes
const loadSaved = async () => {
  try {
    const { data, error } = await supabase
      .from("quotes")
      .select("id,number,customer_name,total,created_at")
      .order("created_at", { ascending: false });

    if (error) throw error;
    setSaved(data || []);
  } catch (err) {
    // Make the error obvious in Console and to the user
    console.error("loadSaved failed:", err);
    alert(`Could not load saved quotes.\n${err?.message || err}`);
    setSaved([]);
  }
};


// "All" | "HVF Agency" | "Victor Engineering" | "Mahabir Hardware Stores"


// Show first 2–3 item names, then “+ etc.”
const summarizeItems = (row) => {
  const items = row?.quote_items || [];
  const names = items.map((i) => i?.name).filter(Boolean);
  if (names.length === 0) return "—";
  const shown = names.slice(0, 3).join(", ");
  return names.length > 3 ? `${shown} + etc.` : shown;
};

// Load quotes WITH their line items (for the detailed page) + build a short items preview
// Adds: in-flight guard to prevent double loads + one retry on Safari's "Load failed"
let __loadingSavedDetailed = false;

const loadSavedDetailed = async () => {
  if (__loadingSavedDetailed) return false;          // ignore duplicate triggers
  __loadingSavedDetailed = true;
  try {
    const run = async () => {
      return await supabase
        .from("quotes")
        .select(`
          id,
          number,
          customer_name,
          address,
          phone,
          total,
          created_at,
          sanctioned_status,
          sanctioned_mode,
          sanctioned_date,
          sanctioned_amount,
          csm_amount,
          rtnad_amount,
          quote_items ( name )
        `)
        .order("created_at", { ascending: false });
    };

    // attempt #1
    let { data, error } = await run();
    if (error) throw error;

    // build preview
    const enriched = (data || []).map((q) => {
      const names = (q.quote_items || []).map((it) => it?.name || "");
      return {
        ...q,
        _itemsPreview: names.slice(0, 3),
        _itemsTotal: names.length,
      };
    });

    setSavedDetailed(enriched);
    return true;
  } catch (err) {
    // Safari occasionally throws "TypeError: Load failed" / "network connection was lost"
    const msg = String(err?.message || err || "");
    if (
      msg.includes("Load failed") ||
      msg.includes("Failed to fetch") ||
      msg.includes("network connection was lost")
    ) {
      // brief retry
      await new Promise((r) => setTimeout(r, 300));
      try {
        const { data, error } = await supabase
          .from("quotes")
          .select(`
            id,
            number,
            customer_name,
            address,
            phone,
            total,
            created_at,
            sanctioned_status,
            sanctioned_mode,
            sanctioned_date,
            sanctioned_amount,
            csm_amount,
            rtnad_amount,
            quote_items ( name )
          `)
          .order("created_at", { ascending: false });
        if (error) throw error;

        const enriched = (data || []).map((q) => {
          const names = (q.quote_items || []).map((it) => it?.name || "");
          return {
            ...q,
            _itemsPreview: names.slice(0, 3),
            _itemsTotal: names.length,
          };
        });
        setSavedDetailed(enriched);
        return true;
      } catch (retryErr) {
        console.error("loadSavedDetailed retry failed:", retryErr);
        alert(`Could not load saved quotes (detailed).\n${retryErr?.message || retryErr}`);
        setSavedDetailed([]);
        return false;
      }
    }

    console.error("loadSavedDetailed failed:", err);
    alert(`Could not load saved quotes (detailed).\n${err?.message || err}`);
    setSavedDetailed([]);
    return false;
  } finally {
    __loadingSavedDetailed = false;
  }
};

// Open the full-screen detailed view
const goToSavedDetailed = async () => {
  await loadSavedDetailed();
  setPage("savedDetailed");
};

const openSavedDetail = async () => {
  await loadSavedDetailed();
  setPage("savedDetailed");
};

// Load one saved quote into the editor
const editSaved = async (number) => {
  try {
    // 1) Header
    const { data: q, error: qerr } = await supabase
      .from("quotes")
      .select("id,number,customer_name,address,phone,subject")
      .eq("number", number)
      .maybeSingle();
    if (qerr) throw qerr;
    if (!q) return;

    // 2) Lines
    const { data: lines, error: lerr } = await supabase
      .from("quote_items")
      .select("name,specs,qty,mrp")
      .eq("quote_id", q.id);
    if (lerr) throw lerr;

    // 3) Rebuild cart
    const newCart = {};
    (lines || []).forEach((ln, idx) => {
      const id = `saved-${idx}`;
      newCart[id] = {
  id,
  name: ln.name,
  specs: ln.specs || "",
  unit: Number(ln.mrp || 0),
  qty: Number(ln.qty || 0),
  gst: 18, // default GST %
};
    });
    setCart(newCart);

    // 4) Align firm with number; mark as loaded-from-saved
    const firmGuess = inferFirmFromNumber(q.number);
    if (firmGuess) setFirm(firmGuess);
    setLoadedFromSaved(true);

    // 5) Push state & open editor
    setQHeader((h) => ({
      ...h,
      number: q.number,
      customer_name: q.customer_name || "",
      address: q.address || "",
      phone: q.phone || "",
      subject: q.subject || "",
      date: todayStr(),
    }));

    setEditingQuoteId(q.id);   // remember which quote row we’re editing
    setSavedOnce(true);        // this quote already exists in DB

    setQuoteMode(true);
    setPage("quoteEditor");
  } catch (err) {
    console.error("editSaved failed:", err);
    alert(`Could not load the saved quote.\n${err?.message || err}`);
  }
};

// Delete a saved quote (header + items) and then rewind that firm's counter
const deleteSavedQuote = async (ref) => {
  const isNumber = typeof ref === "string" && ref.length > 0;
  const isObj = !!(ref && typeof ref === "object" && ref.id);

  if (!isNumber && !isObj) return;

  const label = isNumber ? `quote ${ref}` : "this Internal quote";
  const ok = confirm(`Delete ${label}? This cannot be undone.`);
  if (!ok) return;

  try {
    let qid = null;
    let number = isNumber ? ref : (ref.number || "");

    if (isNumber) {
      const { data: q, error: qerr } = await supabase
        .from("quotes")
        .select("id,number")
        .eq("number", ref)
        .maybeSingle();
      if (qerr) throw qerr;
      if (!q?.id) throw new Error(`Quote not found: ${ref}`);
      qid = q.id;
      number = q.number;
    } else {
      qid = ref.id;
    }

// Persist "Sanctioned" (HVF)
const saveSanction = async () => {
  setSanctionErr("");

  // Basic validation
  const d = (sanctionForm.date || "").trim();
  if (!d) { setSanctionErr("Date is required"); return; }

  const isPartial = sanctionForm.mode === "partial";
  let amt = null;
  if (isPartial) {
    const n = Number(sanctionForm.amount);
    if (!Number.isFinite(n) || n <= 0) {
      setSanctionErr("Enter valid amount");
      return;
    }
    amt = n;
  }

  if (!sanctionTarget?.id) { setSanctionErr("Invalid quote"); return; }

  // Save
  setSavingSanction(true);
  try {
    const payload = {
      sanctioned_status: "sanctioned",
      sanctioned_mode: sanctionForm.mode,   // "full" | "partial"
      sanctioned_date: d,                   // yyyy-mm-dd
      sanctioned_amount: amt,               // null for full
    };

    const { error } = await supabase
      .from("quotes")
      .update(payload)
      .eq("id", sanctionTarget.id);

    if (error) throw error;

    alert("Sanction saved ✅");
    await loadSavedDetailed(); // refresh table
    closeSanction();
  } catch (e) {
    console.error(e);
    setSanctionErr(e?.message || "Could not save. Try again");
  } finally {
    setSavingSanction(false);
  }
};

    const firmOfQuote = inferFirmFromNumber(number) || "Internal";

    // Delete items then header
    const { error: ierr } = await supabase
      .from("quote_items")
      .delete()
      .eq("quote_id", qid);
    if (ierr) throw ierr;

    const { error: derr } = await supabase
      .from("quotes")
      .delete()
      .eq("id", qid);
    if (derr) throw derr;

    // Rewind counter only for numbered firms
    if (firmOfQuote !== "Internal") {
      const { error: rpcErr } = await supabase.rpc("sync_counter_to_max", {
        p_firm: firmOfQuote,
      });
      if (rpcErr) throw rpcErr;
    }

    // Update UI immediately
    setSaved((arr) => (arr || []).filter((r) => r.number !== number));
    setSavedDetailed((arr) => (arr || []).filter((r) => r.id !== qid));
    loadSaved();

    // If the editor is showing this quote, clear editor state
    if (
      (qHeader.number && qHeader.number === number) ||
      (firmOfQuote === "Internal" && editingQuoteId === qid)
    ) {
      setQHeader((h) => ({ ...h, number: "" }));
      setSavedOnce(false);
    }

    alert(`Deleted ${isNumber ? number : "Internal"} ✅`);
  } catch (err) {
    console.error("deleteSavedQuote failed:", err);
    alert(`Delete failed: ${err?.message || err}`);
  }
};

// ===== Delivered: Save handler (moves one row to Delivered & switches view) =====
async function saveDeliverLocal() {
  try {
    const row = deliverPop?.row;
    if (!row || !row.id) {
      alert("No row selected.");
      return;
    }

    // ---- normalize date
    const dateISO = (deliverForm?.date || new Date().toISOString().slice(0, 10));

    // ---- normalize items (DB expects text[] of names)
    let items = [];
    if (Array.isArray(deliverForm?.items)) {
      // support either [{name, delivered}] or plain strings
      items = deliverForm.items
        .map((it) => {
          if (typeof it === "string") return it.trim();
          const nm = (it?.name || "").trim();
          return it?.delivered ? nm : ""; // only keep delivered=true
        })
        .filter(Boolean);
    }

    // ---- tiny helper to coerce numbers safely
    const toNumOrNull = (v) => {
      if (v === undefined || v === null || v === "") return null;
      const n = Number(String(v).replace(/[^0-9.]/g, ""));
      return Number.isFinite(n) ? n : null;
    };

    // amounts as edited in dialog (fallback to row’s values)
    const sanctioned_amount = toNumOrNull(deliverForm?.sanctioned) ?? (row.sanctioned_amount ?? null);
    const csm_amount       = toNumOrNull(deliverForm?.csm)        ?? (row.csm_amount ?? null);
    const rtnad_amount     = toNumOrNull(deliverForm?.rtnad)      ?? (row.rtnad_amount ?? null);

    // remarks
    const remarks = (deliverForm?.adjust ?? "").toString().trim() || (row.remarks ?? "");

    // ===================== NEW: write to Supabase `delivered` =====================
    try {
      const upsertPayload = {
        quote_id: row.id,                   // uuid (unique per delivered row)
        delivered_on: dateISO,              // date
        items_delivered: items,             // text[]
        sanctioned_mode: (row?.sanctioned_mode || "full"), // text
        sanctioned_amount,                  // numeric
        csm_amount,                         // numeric
        rtnad_amount,                       // numeric
        remarks: remarks || null,           // text
      };

      const { error: dErr } = await supabase
        .from("delivered")
        .upsert(upsertPayload, { onConflict: "quote_id" }); // ensure idempotent per quote

      if (dErr) throw dErr;
    } catch (insErr) {
      console.error("Delivered upsert failed:", insErr);
      alert("Could not save to Delivered table: " + (insErr?.message || insErr));
      return; // stop here if DB write failed
    }
    // ============================================================================

    // keep your local snapshot (safe to retain for UX)
    try {
      const KEY = "hvf.delivered";
      let list = JSON.parse(localStorage.getItem(KEY) || "[]");
      if (!Array.isArray(list)) list = [];
      const payload = {
        id: row.id,
        number: row.number,
        customer_name: row.customer_name,
        phone: row.phone,
        address: row.address,
        total: row.total,
        delivered_date: dateISO,
        items: Array.isArray(deliverForm?.items) ? deliverForm.items : [],
        remarks,
        sanctioned_amount,
        csm_amount,
        rtnad_amount,
      };
      const idx = list.findIndex((x) => x && x.id === payload.id);
      if (idx >= 0) list[idx] = payload;
      else list.unshift(payload);
      localStorage.setItem(KEY, JSON.stringify(list));

      // remember ids (so Sanctioned view hides it instantly)
      const IDS_KEY = "hvf.deliveredIds";
      let ids = JSON.parse(localStorage.getItem(IDS_KEY) || "[]");
      if (!Array.isArray(ids)) ids = [];
      if (!ids.includes(payload.id)) ids.push(payload.id);
      localStorage.setItem(IDS_KEY, JSON.stringify(ids));
    } catch {}

    // also update header flags on quotes (nice-to-have)
    try {
      await supabase
        .from("quotes")
        .update({
          delivered_date: dateISO,
          delivered_flag: true,
          sanctioned_status: null,
          sanctioned_mode:   null,
          sanctioned_date:   null,
          sanctioned_amount: null,
          csm_amount,
          rtnad_amount,
        })
        .eq("id", row.id);
    } catch (e) {
      console.warn("Soft warning: quotes update failed (delivered saved anyway):", e?.message);
    }

    // close dialog & switch to Delivered
    setDeliverPop({ open: false, row: null });
    // If you have a fetch function for Delivered, call it here; otherwise the page reload will pick it up.
    try {
      if (typeof dbFetchDelivered === "function") await dbFetchDelivered();
    } catch {}
    setSavedView("delivered");
    try { localStorage.setItem("hvf.savedView", "delivered"); } catch {}

    alert("Saved to Delivered ✅");
  } catch (e) {
    alert(e?.message || "Could not save to Delivered.");
  }
}

 /* ---------- CLEAN PDF (NOT web print) ---------- */
const exportPDF = async () => {
  if (cartList.length === 0) return alert("Nothing to print.");

  // Use the currently selected date, or fallback to today if empty
  const selectedDate =
    qHeader.date && qHeader.date.trim() ? qHeader.date.trim() : todayStr();

  // Keep header.date in sync only if it was empty before
  setQHeader((h) =>
    h.date && h.date.trim() ? h : { ...h, date: selectedDate }
  );

  const dateStr = selectedDate;

  // Pre-open blank window/tab for the PDF (needed for iOS Safari)
  let pdfWindow = null;
  try {
    pdfWindow = window.open("", "_blank");
  } catch (e) {
    pdfWindow = null; // if blocked, we'll fall back later
  }

  // Save for ALL firms. For Internal we save without a number.
  let number = "";
  try {
    if (firm !== "Internal") {
      number = await ensureFirmNumber();
    }
    const savedNum = await saveQuote(number);
    if (firm !== "Internal" && !savedNum) return;
  } catch (e) {
    console.error(e);
    alert("Could not save before exporting. Aborting.");
    return;
  }

  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pw = doc.internal.pageSize.getWidth();
  const ph = doc.internal.pageSize.getHeight();
  const margin = 40;
  const L = margin;
  const R = pw - margin;
  const contentW = R - L;

  // -------------------------------
  // BRANDING / HEADER AREA
  // -------------------------------
  let afterHeaderY;

  if (firm === "Internal") {
  // Simple title
  doc.setFont("helvetica", "bold");
    doc.setFontSize(16);
    doc.text("QUOTATION", pw / 2, 86, { align: "center" });

    // Right-top: Date (no Ref, no Total for Internal)
doc.setFont("helvetica", "normal");
doc.setFontSize(10);
doc.text(`Date: ${dateStr}`, R, 86, { align: "right" });

    // Left block (To)
    let y0 = 110;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(11);
    doc.text("To,", L, y0); y0 += 18;

    doc.setFont("helvetica", "bold");
    doc.text(String(qHeader.customer_name || ""), L, y0); y0 += 16;
    doc.text(String(qHeader.address || ""), L, y0);       y0 += 16;
    doc.text(String(qHeader.phone || ""), L, y0);

    // Table will start a bit lower
    afterHeaderY = y0 + 38;
  } else if (firm === "HVF Agency") {
    // HVF: logo + QUOTATION (unchanged)
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

    doc.setFont("helvetica", "bold");
    doc.setFontSize(16);
    doc.text("QUOTATION", pw / 2, logoBottom + 28, { align: "center" });

    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);

    // Left block (To)
    let y0 = logoBottom + 40;
    doc.setFontSize(11);
    doc.text("To,", L, y0);
    y0 += 18;

    doc.setFont("helvetica", "bold");
    doc.text(String(qHeader.customer_name || ""), L, y0);
    y0 += 16;
    doc.text(String(qHeader.address || ""), L, y0);
    y0 += 16;
    doc.text(String(qHeader.phone || ""), L, y0);

    // Right meta (HVF keeps "Ref:")
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.text(`Ref: ${number}`, R, logoBottom + 40, { align: "right" });
    doc.text(`Date: ${dateStr}`, R, logoBottom + 55, { align: "right" });

    // Intro
    const introY = y0 + 28;
    doc.setFontSize(11);
    doc.text("Dear Sir/Madam,", L, introY);
    doc.text(
      "With reference to your enquiry we are pleased to offer you as under:",
      L,
      introY + 16
    );

    afterHeaderY = introY + 38; // table start
  } else if (firm === "Victor Engineering") {
    // Victor Engineering — single outer frame + divider lines (no inner boxes)
    const LINE_W = 0.9;
    const gap = 10; // vertical spacing between strips
    const subH = 26;
    const introH = 36;

    // Title
    doc.setFont("times", "bold");
    doc.setFontSize(22);
    doc.text("Victor Engineering", pw / 2, 60, { align: "center" });
    doc.setFontSize(14);
    doc.text("PERFORMA INVOICE", pw / 2, 80, { align: "center" });

    // Outer frame
    const frameTop = 92;
    // Height of the outer frame: from 92pt down to page bottom minus 40pt margin
    const frameH = ph - 40 - frameTop;
    doc.setLineWidth(LINE_W);
    doc.rect(L, frameTop, contentW, frameH);

    // Header band: bottom line + vertical split only
    const headerH = 86;
    const headerBottom = frameTop + headerH;
    const splitX = L + contentW * 0.6;

    doc.line(L, headerBottom, R, headerBottom);
    doc.line(splitX, frameTop, splitX, headerBottom);

    // Left (To:)
    doc.setFont("times", "normal");
    doc.setFontSize(11);
    doc.text("To,", L + 10, frameTop + 18);
    doc.setFont("times", "bold");
    doc.text(String(qHeader.customer_name || ""), L + 10, frameTop + 36);
    doc.text(String(qHeader.address || ""), L + 10, frameTop + 52);
    doc.text(String(qHeader.phone || ""), L + 10, frameTop + 68);

    // Right (Ref/Date/GSTIN)
    doc.setFont("times", "normal");
    const rx = splitX + 10;
    doc.text(`Ref No : ${number}`, rx, frameTop + 20);
    doc.text(`Date   : ${dateStr}`, rx, frameTop + 36);
if (firm === "Victor Engineering") {
  doc.text(`GSTIN  : 18BCYCP9744A1ZA`, rx, frameTop + 52);
}

    // Subject strip — single top line
    const subTop = headerBottom + gap;
    doc.line(L, subTop, R, subTop);
    doc.setFont("times", "normal");
    doc.text("Sub :  Performa Invoice for Machinery", L + 10, subTop + 18);

    // Intro strip — single top line
    const introTop = subTop + subH + gap;
    doc.line(L, introTop, R, introTop);
    doc.text("Dear Sir/Madam,", L + 10, introTop + 16);
    doc.text(
      "With reference to your enquiry we are pleased to offer you as under:",
      L + 10,
      introTop + 30
    );

    // Table starts after intro block
    afterHeaderY = introTop + introH;
  } else {
    // Mahabir Hardware Stores
    doc.setFont("courier", "bold");
    doc.setFontSize(20);
    doc.text("Mahabir Hardware Stores", pw / 2, 48, { align: "center" });

    doc.setFont("courier", "bold");
    doc.setFontSize(16);
    doc.text("QUOTATION", pw / 2, 74, { align: "center" });

    doc.setFont("courier", "normal");
    doc.setFontSize(10);

    let y0 = 92;
    doc.setFontSize(11);
    doc.text("To,", L, y0);
    y0 += 18;

    doc.setFont("courier", "bold");
    doc.text(String(qHeader.customer_name || ""), L, y0);
    y0 += 16;
    doc.text(String(qHeader.address || ""), L, y0);
    y0 += 16;
    doc.text(String(qHeader.phone || ""), L, y0);

    doc.setFont("courier", "normal");
    doc.setFontSize(10);
    // Mahabir label: Quotation Number
    doc.text(`Quotation Number: ${number}`, R, 92, { align: "right" });
    doc.text(`Date: ${dateStr}`, R, 107, { align: "right" });

    const introY = y0 + 28;
    doc.setFontSize(11);
    doc.text("Dear Sir/Madam,", L, introY);
    doc.text(
      "With reference to your enquiry we are pleased to offer you as under:",
      L,
      introY + 16
    );

    afterHeaderY = introY + 38;
  }

// -------------------------------
// ITEMS TABLE (all firms)
// -------------------------------

// Reuse the existing description two-line helpers once,
// so we don’t duplicate them in both branches.
const __descDidParse = (data) => {
  if (data.section !== "body" || data.column.index !== 1) return;

  const raw = (data.cell.raw ?? "").toString();
  const nl = raw.indexOf("\n(");
  if (nl === -1) return;

  const name = raw.slice(0, nl);
  const specs = raw.slice(nl);

  if (firm === "Mahabir Hardware Stores") {
    data.cell.text = [name, specs];
    delete data.cell._specs;
  } else {
    data.cell.text = [name, " "];
    data.cell._specs = specs;
  }
};

const __descDidDraw = (data) => {
  if (data.section !== "body") return;
  if (data.column.index !== 1) return;

  const specs = data.cell && data.cell._specs;
  if (!specs) return;

  const cellPad = (side) => {
    if (typeof data.cell.padding === "function") return data.cell.padding(side);
    const cp = data.cell.styles?.cellPadding;
    if (typeof cp === "number") return cp;
    if (cp && typeof cp === "object") return cp[side] ?? 6;
    return 6;
  };
  const padLeft = cellPad("left");
  const padRight = cellPad("right");
  const padTop = cellPad("top");

  const x = data.cell.x + padLeft;

  const fsMain = (data.row.styles && data.row.styles.fontSize) || 10;
  const lineHMain = fsMain * 1.15;
  const specsY = data.cell.y + padTop + lineHMain;

  const maxW = data.cell.width - padLeft - padRight;
  const wrapped = doc.splitTextToSize(specs, maxW);

  const prevSize = doc.getFontSize();
  doc.setFontSize(prevSize * 0.85);
  doc.setTextColor(120);
  doc.text(wrapped, x, specsY);
  doc.setTextColor(0, 0, 0);
  doc.setFontSize(prevSize);
};

// Common theming (unchanged)
const headFill =
  firm === "Victor Engineering"
    ? [220, 235, 255]
    : firm === "Mahabir Hardware Stores"
    ? [225, 248, 225]
    : [230, 230, 230];

const tableFont =
  firm === "Victor Engineering"
    ? "times"
    : firm === "Mahabir Hardware Stores"
    ? "courier"
    : "helvetica";

if (!gstBreakdown) {
  // ===== Legacy table (no GST columns) — UNCHANGED =====
  const colSl = 28;
  const colQty = 40;
  const colUnit = 90;
  const colTotal = 110;
  const colDesc = Math.max(
    120,
    contentW - (colSl + colQty + colUnit + colTotal)
  );

  const body = cartList.map((r, i) => [
    String(i + 1),
    `${r.name || ""}${r.specs ? `\n(${r.specs})` : ""}`,
    String(r.qty || 0),
    inr(r.unit || 0),
    inr((r.qty || 0) * (r.unit || 0)),
  ]);

  autoTable(doc, {
    startY: afterHeaderY,
    head: [["Sl.", "Description", "Qty", "Unit Price", "Total (Incl. GST)"]],
    body,
    styles: {
      font: tableFont,
      fontSize: 10,
      cellPadding: 6,
      overflow: "linebreak",
      textColor: [0, 0, 0],
    },
    headStyles: { fillColor: headFill, textColor: [0, 0, 0], fontStyle: "bold" },
    columnStyles: {
      0: { cellWidth: colSl, halign: "center" },
      1: { cellWidth: colDesc },
      2: { cellWidth: colQty, halign: "center" },
      3: { cellWidth: colUnit, halign: "right" },
      4: { cellWidth: colTotal, halign: "right" },
    },
    margin: { left: margin, right: margin },
    tableLineColor: [200, 200, 200],
    tableLineWidth: firm === "Mahabir Hardware Stores" ? 0.7 : 0.5,
    theme: "grid",
    didParseCell: __descDidParse,
    didDrawCell: __descDidDraw,
  });
} else {
  // ===== GST table (ONLY the table changes) =====
  // Columns: Sl | Description | GST% | Qty | Unit (Excl. GST) | Total (Incl. GST)
  const colSl = 28;
  const colGST = 36;
  const colQty = 40;
  const colUnitEx = 90;
  const colTotal = 110;
  const colDesc = Math.max(
    120,
    contentW - (colSl + colGST + colQty + colUnitEx + colTotal)
  );

  const body = cartList.map((r, i) => {
    const gst = Number.isFinite(r?.gst) ? Number(r.gst) : 18;
    const qty = Number(r.qty || 0);
    const incl = Number(r.unit || 0);
    const excl = incl / (1 + gst / 100);

    return [
      String(i + 1),
      `${r.name || ""}${r.specs ? `\n(${r.specs})` : ""}`,
      `${gst}%`,
      String(qty || 0),
      (Number(excl || 0)).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),  // Unit (Excl. GST)
      inr(qty * incl || 0),          // Total (Incl. GST)
    ];
  });

  autoTable(doc, {
    startY: afterHeaderY,
    head: [["Sl.", "Description", "GST%", "Qty", "Unit Price (Excl. GST)", "Total (Incl. GST)"]],
    body,
    styles: {
      font: tableFont,
      fontSize: 10,
      cellPadding: 6,
      overflow: "linebreak",
      textColor: [0, 0, 0],
    },
    headStyles: { fillColor: headFill, textColor: [0, 0, 0], fontStyle: "bold" },
    columnStyles: {
      0: { cellWidth: colSl, halign: "center" },
      1: { cellWidth: colDesc },
      2: { cellWidth: colGST, halign: "center" },
      3: { cellWidth: colQty, halign: "center" },
      4: { cellWidth: colUnitEx, halign: "right" },
      5: { cellWidth: colTotal, halign: "right" },
    },
    margin: { left: margin, right: margin },
    tableLineColor: [200, 200, 200],
    tableLineWidth: firm === "Mahabir Hardware Stores" ? 0.7 : 0.5,
    theme: "grid",
    didParseCell: __descDidParse,
    didDrawCell: __descDidDraw,
  });
}

    // -------------------------------
// TOTAL LINE
// -------------------------------
const at = doc.lastAutoTable || null;
const totalsRightX = R - 10;
let totalsY = (at?.finalY ?? afterHeaderY) + 18;

if (firm === "Victor Engineering") {
    // Just the text (no extra separator line)
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.text(`Total = Rs ${inr(cartSubtotal)}`, totalsRightX, totalsY, {
      align: "right",
    });
  } else {
    // HVF & Mahabir keep ₹ style
    try {
      await loadRupeeFont(doc);
      doc.setFont("NotoSans", "bold");
      doc.setFontSize(12);
      const RUPEE = String.fromCharCode(0x20b9);
      doc.text(`Total: ${RUPEE} ${inr(cartSubtotal)}`, totalsRightX, totalsY, {
        align: "right",
      });
    } catch {
      doc.setFont("helvetica", "bold");
      doc.setFontSize(12);
      doc.text(`Total: Rs ${inr(cartSubtotal)}`, totalsRightX, totalsY, {
        align: "right",
      });
    }
  }

  // -------------------------------
// TERMS & BANK (HVF min anchor at ~60% page height)
// -------------------------------
let ty = totalsY + 28;
// Only anchor for HVF when the table is short
if (firm === "HVF Agency") {
  const minTermsTop = Math.round(ph * 0.60); // 60% down the page
  if (ty < minTermsTop) ty = minTermsTop;
}

    if (firm === "Internal") {
    // Internal: no Terms & Conditions or Bank section
  } else if (firm === "Victor Engineering") {
    // Keep TERMS box, BANK as text only (no rectangle)
    const termsH = 110;

    // TERMS rectangle (kept)
    doc.setDrawColor(90);
    doc.setLineWidth(0.9);
    doc.rect(L, ty, contentW, termsH);

    doc.setFont("times", "bold");
    doc.setFontSize(11);
    doc.text("Terms & Conditions", L + 10, ty + 16);

    doc.setFont("times", "normal");
    doc.setFontSize(10);
    doc.text(
      [
        "Price will be including GST % as applicable.",
        "This Performa Invoice is valid for 15 days only.",
        "Delivery ex-stock/2 weeks.",
        "Goods once sold cannot be taken back.",
      ],
      L + 10,
      ty + 34
    );

        // BANK section — NO rectangle (tighter + wrapped to stay inside frame)
    const bankTop = Math.min(ty + termsH + 6, ph - margin - 90); // clamp inside page/frame bottom

    // Heading
    doc.setFont("times", "bold");
    doc.setFontSize(10);
    doc.text("BANK DETAILS", L + 10, bankTop + 14);

    // Body (smaller font + wrapped within contentW so it doesn't stick out)
    doc.setFont("times", "normal");
    doc.setFontSize(9);

    const bankLines = [
      "M/S VICTOR ENGINEERING",
      "Axis Bank (Moran, 785670)",
      "Current Account",
      "A/C No: 921020019081364",
      "IFSC: UTIB0003701",
    ];

    const bankWrapped = doc.splitTextToSize(
      bankLines.join("\n"),
      contentW - 20       // keep safely inside left/right frame
    );
    doc.text(bankWrapped, L + 10, bankTop + 28);

    // reset draw defaults
    doc.setDrawColor(0);
    doc.setLineWidth(0.5);
  } else {
    // HVF & Mahabir: unchanged
    const tableFontLocal =
      firm === "Mahabir Hardware Stores" ? "courier" : "helvetica";

    doc.setFont(tableFontLocal, "bold");
    doc.setFontSize(11);
    doc.text("Terms & Conditions:", L, ty, { underline: true });

    doc.setFont(tableFontLocal, "normal");
    doc.setFontSize(10);
    doc.text(
      [
        "This quotation is valid for six month from the date of issue.",
        "Delivery is subject to stock availability and may take up to 2 weeks.",
        "Goods once sold are non-returnable and non-exchangeable.",
        "",
        "Yours Faithfully",
        firm === "Mahabir Hardware Stores" ? "Mahabir Hardware Stores" : "HVF Agency",
        firm === "Mahabir Hardware Stores" ? "—" : "9957239143 / 9954425780",
        firm === "Mahabir Hardware Stores" ? "GST: 18ACBPA2363D1Z9" : "GST: 18AFCPC4260P1ZB",
        "",
      ],
      L,
      ty + 16
    );

    doc.setFont(tableFontLocal, "bold");
    doc.text("BANK DETAILS", L, ty + 120);

    doc.setFont(tableFontLocal, "normal");
    let bankLines = [];
    if (firm === "HVF Agency") {
      bankLines = [
        "HVF AGENCY",
        "ICICI BANK (Moran Branch)",
        "A/C No - 199505500412",
        "IFSC Code - ICIC0001995",
      ];
    } else {
      bankLines = [
        "AC No. 11010061051",
        "IFSC Cord - SBIN0007368",
        "Branch - Moran Branch",
      ];
    }
    doc.text(bankLines, L, ty + 136);
  }

  // ===== INTERNAL WATERMARK (draw LAST so it overlays table with low opacity) =====
if (firm === "Internal") {
  try {
    if (doc.GState && doc.setGState) {
      doc.setGState(new doc.GState({ opacity: 0.35 })); // lighter than before
    }
  } catch {}
  doc.setFont("helvetica", "bold");
  doc.setFontSize(110);
  doc.setTextColor(190); // fallback grey if GState not available
  doc.text("NOT VALID", pw / 2, (ph / 2) - 216, { angle: -30, align: "center" });
  // reset
  doc.setTextColor(0, 0, 0);
  try {
    if (doc.GState && doc.setGState) {
      doc.setGState(new doc.GState({ opacity: 1 }));
    }
  } catch {}
}

// Done — open in new tab (iPhone-friendly)
const pdfBlobUrl = doc.output("bloburl");

if (pdfWindow && !pdfWindow.closed) {
  try {
    pdfWindow.location.href = pdfBlobUrl;
  } catch (e) {
    // Fallback if Safari blocks or throws
    window.open(pdfBlobUrl, "_blank");
  }
} else {
  // Fallback if the pre-opened window could not be created
  window.open(pdfBlobUrl, "_blank");
}
};

// Helper: safely read delivered records from localStorage
// Prefer the new "hvf.delivered" key; fall back to legacy keys.
const getDeliveredList = () => {
  try {
    // Prefer the newer list that contains sanctioned_amount, csm_amount, rtnad_amount
    let raw = localStorage.getItem("hvf.deliveredList");
    if (!raw) raw = localStorage.getItem("hvf.delivered");     // older key
    if (!raw) raw = localStorage.getItem("hvf_delivered");     // legacy underscore
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
};

// Remove a delivered record everywhere (list + ids)
function unmarkDeliveredById(id) {
  // remove id from hvf.deliveredIds
  try {
    let ids = JSON.parse(localStorage.getItem("hvf.deliveredIds") || "[]");
    if (Array.isArray(ids)) {
      ids = ids.filter(x => x !== id);
      localStorage.setItem("hvf.deliveredIds", JSON.stringify(ids));
    }
  } catch {}

  // remove record from hvf.delivered (and mirror legacy key)
  try {
    let list = JSON.parse(localStorage.getItem("hvf.delivered") || "[]");
    if (Array.isArray(list)) {
      list = list.filter(x => x && x.id !== id);
      localStorage.setItem("hvf.delivered", JSON.stringify(list));
      try { localStorage.setItem("hvf_delivered", JSON.stringify(list)); } catch {}
    }
  } catch {}
}

// ---- Delivered (Supabase) helpers ----
async function dbFetchDelivered() {
  // push rows into state in one place
  const applyRows = (rows) => {
    const safe = Array.isArray(rows) ? rows : [];
    setDeliveredRowsDB(safe);
    setDeliveredIdsDB(safe.map((r) => r.id).filter(Boolean));
    return safe;
  };

  // legacy/offline cache (used ONLY if Supabase is unreachable)
  const localList = getDeliveredList();

  try {
    // 1) Fetch ONLY from delivered (no JOIN) — avoids FK/relationship name dependency
    const { data: dRows, error: dErr } = await supabase
      .from("delivered")
      .select(
        "quote_id, delivered_on, items_delivered, sanctioned_mode, sanctioned_amount, csm_amount, rtnad_amount, remarks"
      )
      .order("delivered_on", { ascending: false });

    if (dErr) throw dErr;

    const delivered = Array.isArray(dRows) ? dRows : [];
    const quoteIds = [...new Set(delivered.map((r) => r.quote_id).filter(Boolean))];

    // 2) Fetch the matching quote headers (so firm/number/customer are always available)
    let qMap = new Map();
    if (quoteIds.length) {
      const { data: qRows, error: qErr } = await supabase
        .from("quotes")
        .select("id, number, firm, customer_name, phone, total")
        .in("id", quoteIds);
      if (qErr) throw qErr;
      (qRows || []).forEach((q) => qMap.set(q.id, q));
    }

    // 3) Merge into the UI shape your table expects
    const rows = delivered.map((r) => {
      const q = qMap.get(r.quote_id) || {};
      return {
        id: r.quote_id,
        number: q.number || "",
        firm: q.firm || "",
        customer_name: q.customer_name || "",
        phone: q.phone || "",
        total: q.total ?? 0,
        delivered_date: r.delivered_on || null,
        items: r.items_delivered || [],
        sanctioned: r.sanctioned_mode || "",
        sanctioned_amount: r.sanctioned_amount ?? null,
        csm: r.csm_amount ?? null,
        rtnad: r.rtnad_amount ?? null,
        remarks: r.remarks || "",
      };
    });

    // ✅ Supabase is the single source of truth (even if it returns 0)
    return applyRows(rows);
  } catch (e) {
    console.error("dbFetchDelivered:", e?.message || e);
    // Only if Supabase is unreachable, fall back to local cache
    return applyRows(localList);
  }
}

// upsert one delivered record for a quote
async function dbUpsertDelivered(quoteId, payload) {
  // snapshot BEFORE writing delivered record (for global Undo)
  takeSnapshot(`deliver:${quoteId || (payload && payload.quote_id) || ""}`);
  const rec = {
    quote_id: quoteId,
    delivered_on: payload?.date || new Date().toISOString().slice(0,10),
    items_delivered: payload?.items || payload?.items_delivered || [],
    sanctioned_mode: payload?.full ? "full" : (payload?.partial ? "partial" : null),
    sanctioned_amount: payload?.sanctioned_amount ?? payload?.amount ?? null,
    csm_amount: payload?.csm_amount ?? payload?.csm ?? null,
rtnad_amount: payload?.rtnad_amount ?? payload?.rtnad ?? null,
    remarks: payload?.remarks || "",
  };
  const { error } = await supabase.from("delivered").upsert(rec, { onConflict: "quote_id" });
  if (error) throw error;
}

// delete delivered record (Undo)
async function dbDeleteDelivered(quoteId) {
  const { error } = await supabase.from("delivered").delete().eq("quote_id", quoteId);
  if (error) throw error;
}

// ---- Quotes safe update helper (prevents double submits & retries once) ----
const __quotesSaving = new Set();

/**
 * Safe wrapper for updating a quotes row.
 * - Prevents overlapping updates for the same id
 * - Retries once on transient "Load failed"/network errors (Safari quirk)
 */
async function safeUpdateQuote(id, patch) {
  if (!id) throw new Error("safeUpdateQuote: missing id");
  if (__quotesSaving.has(id)) {
    // already saving this row; ignore the duplicate call
    return { skipped: true };
  }
  __quotesSaving.add(id);
  try {
    const run = async () => {
      return await supabase
        .from("quotes")
        .update(patch)
        .eq("id", id)
        .select("id, number")
        .single();
    };

    // 1st attempt
    let { data, error } = await run();
    if (error) throw error;

    return data;
  } catch (e) {
    // Retry once on transient fetch issues Safari reports as "Load failed"
    const msg = String(e?.message || e);
    if (msg.includes("Load failed") || msg.includes("Failed to fetch") || msg.includes("network connection was lost")) {
      await new Promise((r) => setTimeout(r, 300));
      const { data, error } = await supabase
        .from("quotes")
        .update(patch)
        .eq("id", id)
        .select("id, number")
        .single();
      if (error) throw error;
      return data;
    }
    throw e;
  } finally {
    __quotesSaving.delete(id);
  }
}

/* ==== GLOBAL UNDO (helpers) ==== */
// simple stack; keep it small so it never grows unbounded
const [undoStack, setUndoStack] = useState([]);
const [recycleOpen, setRecycleOpen] = useState(false);

// (kept for compatibility; not used by the new bin, harmless to keep)
const [recycleItems, setRecycleItems] = useState([]);
useEffect(() => {
  try {
    const init = JSON.parse(localStorage.getItem("hvf.recycle") || "[]");
    setRecycleItems(Array.isArray(init) ? init : []);
  } catch {
    setRecycleItems([]);
  }
}, []);

/* --- Recycle Bin helpers (single source of truth = hvf.recycleBin) --- */
function getRecycleBin() {
  try {
    const raw = localStorage.getItem("hvf.recycleBin");
    const arr = JSON.parse(raw || "[]");
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
function setRecycleBin(next) {
  try { localStorage.setItem("hvf.recycleBin", JSON.stringify(next)); } catch {}
}

/* Add one deleted quote (de-dup by id, newest first) */
function recycleAdd(row) {
  const entry = {
    savedAt: new Date().toISOString(),
    sourceView: "savedDetailed",
    // keep only fields we might show/restore; avoid risky ones like `items`, `date_created` etc.
    quote: {
      id: row?.id ?? null,
      number: row?.number ?? "",
      firm: row?.firm ?? row?.firm_name ?? null,
      firm_name: row?.firm_name ?? null,   // kept just in case; normalized on restore
      customer_name: row?.customer_name ?? "",
      address: row?.address ?? null,
      phone: row?.phone ?? null,
      total: Number(row?.total || 0),
      sanctioned_status: row?.sanctioned_status ?? null,
      sanctioned_mode: row?.sanctioned_mode ?? null,
      sanctioned_date: row?.sanctioned_date ?? null,
      sanctioned_amount: row?.sanctioned_amount ?? null,
      csm_amount: row?.csm_amount ?? null,
      rtnad_amount: row?.rtnad_amount ?? null,
      remarks: row?.remarks ?? null,
      // DO NOT store `items`, `date_created` etc — they caused schema errors
    },
  };

  const bin = getRecycleBin();
  const filtered = bin.filter(b => String(b?.quote?.id) !== String(entry.quote.id));
  const next = [entry, ...filtered].slice(0, 200);
  setRecycleBin(next);
}

/* ==== RECYCLE BIN (deleted quotes) – state only used by the old UI; safe to keep ==== */
const [recycle, setRecycle] = useState([]);
function saveRecycle(next) {
  setRecycle(next);
  try { localStorage.setItem("hvf.recycle", JSON.stringify(next)); } catch {}
}
useEffect(() => {
  try {
    setRecycle(JSON.parse(localStorage.getItem("hvf.recycle") || "[]"));
  } catch {
    setRecycle([]);
  }
}, []);

/** Delete a quote and push it to the recycle bin, then delete from DB */
async function onDeleteQuote(row) {
  if (!row?.id) return;
  if (!window.confirm(`Delete ${row.number}?`)) return;

  // add to bin, then pop open
  recycleAdd(row);
  setRecycleOpen(false);
  setTimeout(() => setRecycleOpen(true), 0);

  try {
    const { error } = await supabase.from("quotes").delete().eq("id", row.id);
    if (error) throw error;
    await loadSavedDetailed?.();
  } catch (e) {
    alert(e?.message || "Could not delete the quote.");
  }
}

/** Take a snapshot of important browser state (localStorage only for now). */
function takeSnapshot(label = "") {
  try {
    const ls = {
      "hvf.savedView": localStorage.getItem("hvf.savedView"),
      "hvf.deliveredList": localStorage.getItem("hvf.deliveredList"),
      "hvf.delivered": localStorage.getItem("hvf.delivered"),
      "hvf.savedDetailed": localStorage.getItem("hvf.savedDetailed"),
    };
    const snap = { ts: Date.now(), label, ls };
    setUndoStack((s) => [...s, snap]);
    return snap;
  } catch {
    const snap = { ts: Date.now(), label, ls: {} };
    setUndoStack((s) => [...s, snap]);
    return snap;
  }
}

/* Restore one item from Recycle Bin back into "quotes" */
async function onRestoreRecycle(idx) {
  try {
    const bin = getRecycleBin();
    const item = bin[idx];
    if (!item || !item.quote) return;

    // allow-list payload so we never send unknown columns
    const allow = new Set([
  "id","number","firm","firm_name","customer_name","address","phone","total",
  "sanctioned_status","sanctioned_mode","sanctioned_date","sanctioned_amount",
  "csm_amount","rtnad_amount"
]);
    const src = item.quote || {};
    const q = {};
    Object.entries(src).forEach(([k, v]) => {
      if (!allow.has(k)) return;
      if (k === "total") q[k] = Number(v || 0);
      else q[k] = v ?? null;
    });
    // normalize firm field
if (!q.firm && q.firm_name) q.firm = q.firm_name;
// ensure NOT NULL for firm (fallback to snapshot or default)
if (!q.firm) q.firm = (src.firm ?? "HVF Agency");
delete q.firm_name;

// drop fields not in table
delete q.remarks;

    // upsert on id (assumes id is PK/uniq)
    const { error } = await supabase.from("quotes").upsert(q, { onConflict: "id" });
    if (error) throw error;

    // remove from bin + persist
    const next = [...bin];
    next.splice(idx, 1);
    setRecycleBin(next);

    await loadSavedDetailed?.();

    // re-open to refresh rows
    setRecycleOpen(false);
    setTimeout(() => setRecycleOpen(true), 0);
  } catch (e) {
    alert(e?.message || "Could not restore the quotation.");
  }
}

/** Restore a snapshot (and refresh UI). */
function restoreSnapshot(snap) {
  try {
    if (!snap) return;
    Object.entries(snap.ls || {}).forEach(([k, v]) => {
      if (v == null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    });
    window.location.reload();
  } catch (e) {
    console.error("Undo failed:", e);
  }
}

// -- undo handler used by the top-left button (with DB compensation)
const canUndo = undoStack.length > 0;
const onUndo = async () => {
  const snap = undoStack[undoStack.length - 1];
  if (!snap) return;

  try {
    const label = String(snap.label || "");
    if (label.startsWith("sanction:")) {
      const id = label.split(":")[1];
      if (id) {
        await supabase.from("quotes").update({
          sanctioned_date: null,
          sanctioned_mode: null,
          sanctioned_amount: null,
        }).eq("id", id);
        await loadSavedDetailed?.();
      }
    } else if (label.startsWith("deliver:")) {
      const id = label.split(":")[1];
      if (id) {
        await supabase.from("delivered").delete().eq("quote_id", id);
        try {
          const keyList = "hvf.deliveredList";
          const keyIds  = "hvf.deliveredIds";
          const arr = JSON.parse(localStorage.getItem(keyList) || "[]");
          const next = Array.isArray(arr)
            ? arr.filter(r => String(r.id ?? r.quote_id) !== String(id))
            : [];
          localStorage.setItem(keyList, JSON.stringify(next));
          localStorage.setItem(keyIds, JSON.stringify(next.map(r => r.id ?? r.quote_id)));
        } catch {}
        await loadSavedDetailed?.();
      }
    }
  } catch (e) {
    console.warn("Undo compensation failed:", e);
  } finally {
    setUndoStack(s => s.slice(0, -1));
    restoreSnapshot(snap);
  }
};


/*** UI ***/
return (
  <div
      style={{
        minHeight: "100svh",
        background: "linear-gradient(to bottom right,#f8f9fa,#eef2f7)",
      }}
    >

    {/* Global tokens & utilities */}

    <style>{`
:root{
  --bg:#f7f9fc; --paper:#ffffff; --text:#1f2937; --muted:#6b7280;
  --border:#e5e7eb; --primary:#1677ff; --radius:10px;
  --shadow:0 6px 24px rgba(16,24,40,.06);
  --ring:0 0 0 3px rgba(22,119,255,.18);
  --space-1:6px; --space-2:8px; --space-3:12px; --space-4:16px; --space-5:20px;
}

html,body{ -webkit-text-size-adjust:100%; text-size-adjust:100%; }

body{
  color:var(--text);
  background:linear-gradient(180deg,var(--bg),#eef2f7);
  font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",
               Arial,"Noto Sans","Liberation Sans",sans-serif;
}

.container{ max-width:1100px; margin:0 auto; }
.paper{ background:var(--paper); border:1px solid var(--border); border-radius:var(--radius); box-shadow:var(--shadow); }
.section{ padding:var(--space-4); }
.muted{ color:var(--muted); }
.title{ margin:0; font-weight:800; letter-spacing:.2px; }

.btn{ padding:6px 12px; border-radius:6px; border:1px solid var(--border); background:#f8f9fa; cursor:pointer; font-weight:600; }
.btn:hover{ background:#eef1f5; }
.btn.primary{ background:var(--primary); border-color:var(--primary); color:#fff; }
.btn.danger{ background:#fff5f5; border-color:#f3d1d1; color:#b11e1e; }

.chip{ padding:6px 10px; border:1px solid var(--border); border-radius:20px; background:#fff; color:#333; }
.chip.active{ background:var(--primary); color:#fff; border-color:var(--primary); }

input,select,textarea{ padding:6px 10px; border:1px solid var(--border); border-radius:6px; outline:none; width:100%; max-width:100%; box-sizing:border-box; font-size:16px !important; }
input:focus,select:focus,textarea:focus{ box-shadow:var(--ring); border-color:var(--primary); }

table{ width:100%; border-collapse:collapse; font-size:14px; }
th,td{ padding:10px; border-bottom:1px solid var(--border); }
thead th{ background:#f7f7f7; position:sticky; top:0; z-index:1; }
tr:hover td{ background:#fafbff; }

.badge{ font-size:12px; color:#555; background:#f0f0f0; border:1px solid #e2e2e2; border-radius:999px; padding:3px 8px; line-height:1; }

/* --- Tiny pill popovers (CSM / RT-NAD) --- */
.qtable td,
.qtable th { overflow: visible; }         /* allow popovers to overflow cells */
.pill-edit-wrap { position: relative; display: inline-block; }
.pill-pop{
  position:absolute;
  left:50%; transform:translateX(-50%);
  top: calc(100% + 6px);
  background:#fff;
  border:1px solid var(--border);
  border-radius:8px;
  padding:8px;
  box-shadow:var(--shadow), 0 12px 36px rgba(16,24,40,.12);
  z-index: 999;                           /* stay above table */
  width:200px; max-width: min(80vw, 260px);
}
.pill-pop:after{                          /* tiny caret */
  content:""; position:absolute; top:-6px; left:50%;
  transform:translateX(-50%);
  width:0; height:0; border-left:6px solid transparent;
  border-right:6px solid transparent; border-bottom:6px solid #e5e7eb;
}
@media (max-width:640px){
  .pill-pop{ width: 180px; }
}

/* --- Sanctioned View: 3-dot row menu --- */
.rowmenu-pop{
  min-width: 180px;
  background:#fff;
  border:1px solid var(--border);
  border-radius:12px;
  box-shadow:var(--shadow), 0 12px 36px rgba(16,24,40,.12);
  padding:6px;
}
.rowmenu-item{
  width:100%;
  display:flex; align-items:center; gap:8px;
  padding:10px 12px;
  border:none; background:transparent;
  border-radius:8px;
  cursor:pointer;
  font-weight:600; color:#1f2937;
  text-align:left;
}
.rowmenu-item:hover{
  background:#eef4ff;
  border:1px solid #d7e7ff;
}
.rowmenu-item:focus{
  outline:none;
  box-shadow:var(--ring);
}



.rowmenu-item.danger{
  color:#7a5900;            /* “Remove” gets a subtle warning tone */
}
.rowmenu-sep{
  height:1px; margin:4px 6px;
  background:#eee; border:0;
}

/* Catalog cards */
.card{
  background:var(--paper); border:1px solid var(--border); border-radius:var(--radius);
  box-shadow:var(--shadow); overflow:hidden;
  transition:transform .08s ease, box-shadow .2s ease, border-color .2s ease;
  height:100%; display:flex; flex-direction:column;
}
.card:hover{ transform:translateY(-2px); box-shadow:0 12px 36px rgba(16,24,40,.08); border-color:#d7dbe3; }
.card-body{ padding:var(--space-4); display:flex; flex-direction:column; flex:1; }
.thumb{ background:#fff; }

/* product name clamp */
.card-body .pname{
  margin:0 0 6px; font-size:16px; font-weight:700; line-height:1.25;
  min-height:calc(1.25em * 2);
  display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical;
  overflow:hidden; text-overflow:ellipsis;
}
/* specs clamp */
.card-body .specs{
  color:#666; margin:0 0 6px; line-height:1.35;
  display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical;
  overflow:hidden; text-overflow:ellipsis;
}

/* number inputs */
input[type=number]::-webkit-outer-spin-button,
input[type=number]::-webkit-inner-spin-button{ -webkit-appearance:none; margin:0; }
input[type=number]{ -moz-appearance:textfield; }

/* Add/Counter bar */
.addbar{ margin-top:auto; display:flex; justify-content:center; width:100%; }
.addbtn,.qtywrap{
  width:74%; max-width:224px; height:44px; border-radius:10px; border:1.5px solid var(--primary);
  display:flex; align-items:center; justify-content:center; font-weight:700;
  transition:background .15s ease, color .15s ease, box-shadow .15s ease;
}
.addbtn{ background:#fff; color:var(--primary); font-size:108%; }
.addbtn:hover{ background:var(--primary); color:#fff; box-shadow:var(--ring); }
.qtywrap{ background:var(--primary); color:#fff; gap:14px; padding:0 12px; }
.qtywrap .op{ width:44px; height:44px; display:flex; align-items:center; justify-content:center; font-size:20px; border:none; background:transparent; color:#fff; cursor:pointer; }
.qtywrap .op:active{ transform:scale(.96); }
.qtywrap .num{ min-width:76px; height:34px; line-height:34px; text-align:center; background:#fff; color:var(--primary); border-radius:6px; font-weight:800; }

/* Phones */
@media (max-width:640px){
  .card{ display:flex; flex-direction:column; }
  .card-body{ min-height:230px; }
  .addbar{ margin-top:auto; padding-bottom:10px; }

  .catalog-grid{ display:grid !important; grid-template-columns:1fr 1fr; gap:16px; align-items:stretch; }
  .card{ height:100%; }
  .card-body{ flex:1; display:flex; flex-direction:column; }
  .addbar{ margin-top:auto; padding-bottom:10px; }

  .addbtn,.qtywrap{ width:92%; max-width:340px; height:42px; }
  .qtywrap{ gap:10px; padding:0 8px; }
  .qtywrap .op{ width:38px; height:42px; font-size:22px; }
  .qtywrap .num{ min-width:64px; height:32px; line-height:32px; }

  .cat-strip{
    display:flex !important; flex-wrap:nowrap !important; overflow-x:auto !important;
    -webkit-overflow-scrolling:touch; touch-action:pan-x; overscroll-behavior-x:contain;
    padding-bottom:6px; scroll-snap-type:x proximity; scroll-padding-inline:12px; gap:8px;
  }
  .cat-strip::-webkit-scrollbar{ display:none; }
  .cat-strip{ scrollbar-width:none; }
  .cat-strip .chip{ flex:0 0 auto; min-width:160px; max-width:260px; white-space:normal; line-height:1.2; text-align:center; scroll-snap-align:center; }

  html,body{ max-width:100%; overflow-x:hidden; }
}

/* Tablets & Desktop */
@media (min-width:641px){
  .cat-strip{ display:flex !important; flex-wrap:wrap !important; justify-content:center !important; gap:8px !important; overflow:visible !important; padding-bottom:0 !important; scroll-snap-type:none !important; }
  .cat-strip .chip{ min-width:auto !important; max-width:none !important; white-space:nowrap !important; padding:6px 10px !important; border-radius:20px !important; }

  /* Admin form grid */
  .addform-grid{ grid-template-columns:1fr 1fr 1fr; }
}

/* Form hardening */
.addform-grid label{ display:block; min-width:0; }
.addform-grid label > *{ max-width:100%; }
.addform-grid input[type="file"]{ width:100%; }
/* ===== Inline pill popover (CSM/RTNAD) ===== */
.pill-edit-wrap{
  position: relative;               /* anchor for the popover */
  display: inline-block;
}

.pill-pop{
  position: absolute;
  left: 50%;
  transform: translateX(-50%);      /* center under the pill */
  top: calc(100% + 6px);
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  box-shadow: 0 10px 30px rgba(16,24,40,.18);
  padding: 8px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  z-index: 9999;                    /* draw above the table */
  max-width: min(92vw, 320px);
}

.pill-pop input{
  width: 120px;
  padding: 6px 10px;
  border: 1px solid #d7e7ff;
  border-radius: 999px;
  text-align: right;
  font-size: 14px;
}

/* Shared pill button a11y focus + open state */
.pill-btn:focus-visible{
  outline: none;
  box-shadow: var(--ring);
}
.pill-btn[aria-expanded="true"]{
  border-color: var(--primary);
}

button.mini{
  padding: 6px 10px;
  border-radius: 999px;
  border: 1px solid #e5e7eb;
  background: #fff;
  cursor: pointer;
  font-weight: 700;
  font-size: 12px;
}
button.mini.primary{
  background: var(--primary);
  border-color: var(--primary);
  color: #fff;
}

/* Small screens: keep popover visible and compact */
@media (max-width: 640px){
  .pill-pop{ gap: 6px; }
  .pill-pop input{ width: 110px; }
}

`}</style>



      {/* top-right Login menu */}
<div
  style={{ display: "flex", justifyContent: "flex-end", padding: "8px 16px" }}
>
  <details
    ref={loginMenuRef}
    onToggle={(e) => {
      // When opened, start a 10s idle timer. When closed, clear it.
      if (e.currentTarget.open) {
        if (loginIdleTimer.current) clearTimeout(loginIdleTimer.current);
        loginIdleTimer.current = setTimeout(() => {
          if (loginMenuRef.current?.open) loginMenuRef.current.open = false;
          loginIdleTimer.current = null;
        }, 10000); // auto-hide after 10s if nothing chosen
      } else {
        if (loginIdleTimer.current) {
          clearTimeout(loginIdleTimer.current);
          loginIdleTimer.current = null;
        }
      }
    }}
  >
    <summary className="btn">Login</summary>
    <div
      className="paper section"
      style={{ position: "absolute", right: 16, marginTop: 6, minWidth: 230 }}
    >
      <button
        onClick={() => { toggleStaff(); closeLoginMenu(); }}
        className="btn"
        style={{ width: "100%", marginBottom: "var(--space-2)" }}
      >
        {staffMode ? "Logout Staff View" : "Login as Staff (PIN)"}
      </button>

<button
  onClick={() => { sendMagicLink(); closeLoginMenu(); }}
  className="btn"
  style={{ width: "100%", marginBottom: "var(--space-2)" }}
>
  Sign in (email link)
</button>

     <button
        onClick={() => { startAdminFlow(); closeLoginMenu(); }}
        className="btn"
        style={{ width: "100%", marginBottom: "var(--space-2)" }}
      >
        Login as Admin
      </button>

      <button
        onClick={() => { enableQuoteMode(); closeLoginMenu(); }}
        className="btn"
        style={{ width: "100%" }}
      >
        {quoteMode ? "Exit Quotation Mode" : "Login for Quotation (PIN)"}
      </button>
    </div>
  </details>
</div>

     {/* Header (logo always visible; rest hidden on savedDetailed) */}
<>
  <div style={{ textAlign: "center", marginBottom: 12 }}>
<img
  src="/hvf-logo.png"
  alt="HVF Agency"
  style={{
    width: 192,            // 160 → 192 (+20%)
    height: "auto",
    marginBottom: 8,
  }}
/>
  </div>

  {page === "catalog" && (
    <div style={{ textAlign: "center", marginBottom: 18 }}>
      <h1 style={{ margin: 0 }}>HVF Machinery Catalog</h1>
      <p style={{ color: "#777", marginTop: 6 }}>
        by HVF Agency, Moranhat, Assam
      </p>

      {/* inline admin two-step box */}
{showLoginBox && (
  <div
    style={{
      display: "inline-flex",
      gap: 8,
      alignItems: "center",
      flexWrap: "wrap",
      justifyContent: "center",
      marginTop: 8
    }}
  >
    {/* Step 1: email */}
    {(!adminStep || adminStep === "email") && (
      <>
        <input
          type="email"
          placeholder="Enter admin email"
          value={adminEmail}
          onChange={(e) => setAdminEmail(e.target.value)}
          style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #ddd", minWidth: 240 }}
        />
        <button onClick={verifyAdminEmail}>Verify</button>
        <button onClick={() => { setShowLoginBox(false); setAdminStep(null); }}>
          Cancel
        </button>
      </>
    )}

    {/* Step 2: PIN */}
    {adminStep === "pin" && (
      <>
        <input
          type="password"
          inputMode="numeric"
          placeholder="Enter PIN"
          value={adminPin}
          onChange={(e) => setAdminPin(e.target.value)}
          style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #ddd", minWidth: 160 }}
        />
        <button onClick={verifyAdminPin}>Login</button>
        <button onClick={() => { setAdminStep("email"); setAdminPin(""); }}>
          Back
        </button>
      </>
    )}
  </div>
)}

      {/* session badge */}
      {(session || isAdmin) && (
  <div style={{ marginTop: 8 }}>
    <button onClick={signOut} style={{ marginRight: 8 }}>
      {session ? "Sign Out" : "Logout Admin"}
    </button>
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
    {session && (
      <span style={{ color: "#777", fontSize: 12 }}>
        UID: {session?.user?.id?.slice(0, 8)}…
      </span>
    )}
  </div>
)}
    </div>
  )}
</>

     {/* Search (hidden on savedDetailed) */}
{page === "catalog" && (
  <div style={{ maxWidth: 1100, margin: "0 auto 10px", padding: "0 12px" }}>
    <input
      value={search}
      onChange={(e) => setSearch(e.target.value)}
      placeholder="Search products…"
      style={{
        width: "100%",
        padding: "10px 12px",
        borderRadius: 10,
        border: "1px solid #e5e7eb",
      }}
    />
  </div>
)}
         {/* Categories (hidden on savedDetailed) */}
      {page === "catalog" && (
  <>
    <div className="cat-bar" style={{ margin: "0 auto 12px", padding: "0 12px", maxWidth: 1100 }}>
  <div ref={catStripRef} className="cat-strip">
    {["All", ...categories].map((c) => (
      <button
        key={c}
        onClick={() => setCategory(c)}
        className={`chip ${category === c ? "active" : ""}`}
        aria-pressed={category === c}
      >
        {c}
      </button>
    ))}
  </div>
</div>

    {/* --- Admin-only: Add Product panel --- */}
    {isAdmin && (
      <details className="paper section" style={{ maxWidth: 1100, margin: "0 auto 16px" }}>
        <summary className="btn" style={{ cursor: "pointer" }}>
          ➕ Add Product
        </summary>

        <form onSubmit={onSave} style={{ marginTop: 12 }}>
          <div
  className="addform-grid"
  style={{
    display: "grid",
    gap: 10,
    alignItems: "end",
  }}
>
            <label>
              <div style={{ fontSize: 12, color: "#666" }}>Name *</div>
              <input name="name" value={form.name} onChange={onChange} required />
            </label>

            <label>
              <div style={{ fontSize: 12, color: "#666" }}>Category *</div>
              <select
                name="category"
                value={form.category}
                onChange={onChange}
                required
              >
                <option value="" disabled>Select category</option>
                {categories.map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </label>

            <label>
              <div style={{ fontSize: 12, color: "#666" }}>MRP (₹) *</div>
              <input
                type="number"
                name="mrp"
                value={form.mrp}
                onChange={onChange}
                min="0"
                required
              />
            </label>

            <label>
              <div style={{ fontSize: 12, color: "#666" }}>Selling Price (₹)</div>
              <input
                type="number"
                name="sell_price"
                value={form.sell_price}
                onChange={onChange}
                min="0"
              />
            </label>

            <label>
              <div style={{ fontSize: 12, color: "#666" }}>Cost Price (₹)</div>
              <input
                type="number"
                name="cost_price"
                value={form.cost_price}
                onChange={onChange}
                min="0"
              />
            </label>

            <label>
              <div style={{ fontSize: 12, color: "#666" }}>Image *</div>
              <input
                type="file"
                accept="image/*"
                onChange={onChange}
                required
              />
            </label>

            <label style={{ gridColumn: "1 / -1" }}>
              <div style={{ fontSize: 12, color: "#666" }}>Specs / description</div>
              <input
                name="specs"
                value={form.specs}
                onChange={onChange}
                placeholder="Short specs shown on card"
              />
            </label>

<div style={{ gridColumn: "1 / -1", textAlign: "left" }}>
              <button
                type="submit"
                className="btn primary"
                disabled={saving}
              >
                {saving ? "Saving…" : "Save Product"}
              </button>
            </div>
          </div>
        </form>
      </details>
    )}
  </>
)}

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

                  <div className="card-body" style={{ display: "flex", flexDirection: "column" }}>
                    <h3 className="pname" title={m.name}>{m.name}</h3>
                    {m.specs && <p className="specs">{m.specs}</p>}
                    <p style={{ fontWeight: 700 }}>₹{inr(m.mrp)}</p>
                    {(staffMode || isAdmin) && m.sell_price != null && (
  <div
    style={{
      fontWeight: 700,
      marginTop: -2,
      marginBottom: 6,
      display: "flex",
      justifyContent: "center",   // center horizontally
      alignItems: "baseline",
      gap: 8,
      width: "100%",
      alignSelf: "center",
    }}
  >
    <span style={{ color: "#d32f2f" }}>₹{inr(m.sell_price)}</span>
    {isAdmin && m.cost_price != null && (
      <>
        <span style={{ color: "#bbb" }}>/</span>
        <span style={{ color: "#d4a106" }}>
          ₹{inr(m.cost_price)}
        </span>
      </>
    )}
  </div>
)}
                    {m.category && (
                      <p style={{ color: "#777", fontSize: 12 }}>{m.category}</p>
                    )}

                    {quoteMode && (
  <div className="addbar">
    { (cart[m.id]?.qty || 0) > 0 ? (
      <div className="qtywrap" role="group" aria-label="Quantity selector">
        <button className="op" onClick={() => dec(m)} aria-label="Decrease">−</button>
        <div className="num">{cart[m.id]?.qty || 0}</div>
        <button className="op" onClick={() => inc(m)} aria-label="Increase">+</button>
      </div>
    ) : (
      <button className="addbtn" onClick={() => inc(m)}>Add</button>
    )}
  </div>
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
                cursor: "pointer",
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
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 8,
                }}
              >
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
    type="tel"
    inputMode="numeric"
    autoComplete="tel"
    autoCapitalize="off"
    autoCorrect="off"
    maxLength={20}
    pattern="[0-9+() -]*"
    placeholder="e.g. 98765 43210"
    value={qHeader.phone}
    onChange={(e) =>
      setQHeader({ ...qHeader, phone: e.target.value })
    }
  />
</label>

                <div style={{ gridColumn: "1 / span 2", marginTop: 8, fontSize: 14 }}>
                  Dear Sir/Madam,<br />
                  With reference to your enquiry we are pleased to offer you as
                  under:
                </div>
              </div>
            </div>

            {/* right: quotation meta (firm-aware) */}
            <div style={{ width: 240, textAlign: "right" }}>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>
  {firm === "Victor Engineering" ? "PERFORMA INVOICE" : "QUOTATION"}
</div>

{firm !== "Internal" && (
  <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "flex-end" }}>
    <div>
      {firm === "Mahabir Hardware Stores"
        ? "Quotation Number: "
        : firm === "Victor Engineering"
        ? "Ref No: "
        : "Ref: "}
      {qHeader.number ||
        (firm === "Mahabir Hardware Stores"
          ? "MH1052"
          : firm === "Victor Engineering"
          ? "APP/VE001"
          : "APP/H###")}
    </div>
    <button
      type="button"
      onClick={assignNewNumber}
      title="Assign a fresh quotation number"
      style={{
        padding: "4px 10px",
        borderRadius: 6,
        border: "1px solid #d1d5db",
        background: "#f9fafb",
        cursor: "pointer",
      }}
    >
      Assign
    </button>
  </div>
)}

<div
  style={{
    display: "flex",
    justifyContent: "flex-end",
    alignItems: "center",
    gap: 6,
    marginTop: 4,
  }}
>
  <span>Date:</span>
  <input
    type="date"
    value={
      qHeader.date
        ? qHeader.date.split("/").reverse().join("-")
        : ""
    }
    max={new Date().toISOString().slice(0, 10)} // cannot pick future dates
    onChange={(e) => {
      const iso = e.target.value; // "YYYY-MM-DD"
      if (!iso) return;
      const [yyyy, mm, dd] = iso.split("-");
      const nice = `${dd}/${mm}/${yyyy}`; // back to DD/MM/YYYY
      setQHeader((prev) => ({ ...prev, date: nice }));
    }}
    style={{
      border: "1px solid #d1d5db",
      borderRadius: 6,
      padding: "3px 6px",
      fontSize: 12,
    }}
  />
</div>

            </div>
          </div>

          {/* Firm selector */}
          <div
            style={{
              display: "flex",
              gap: 12,
              alignItems: "center",
              marginTop: 12,
              marginBottom: 8,
            }}
          >
            <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 12, color: "#666", minWidth: 44 }}>Firm</span>
              <select
                value={firm}
                onChange={(e) => setFirm(e.target.value)}
                style={{
                  padding: "6px 8px",
                  borderRadius: 6,
                  border: "1px solid #e5e7eb",
                }}
              >
                <option>HVF Agency</option>
<option>Victor Engineering</option>
<option>Mahabir Hardware Stores</option>
<option>Internal</option>
              </select>
<span style={{ marginLeft: 16 }}>
  <Toggle
    checked={gstBreakdown}
    onChange={setGstBreakdown}
    label="GST breakdown"
  />
</span>
            </label>
          </div>

          {/* rows */}
          <div style={{ marginTop: 12 }}>
            <table className="qtable">
              <thead>
  <tr>
    <th style={{ width: 40 }}>Sl.</th>
    <th style={{ width: 220 }}>Description</th>
    <th>Specs / description</th>

    {/* ✅ NEW — only show when GST breakdown is ON */}
    {gstBreakdown && <th style={{ width: 80 }}>GST %</th>}

    <th style={{ width: 80 }}>Qty</th>
    <th style={{ width: 120 }}>Unit Price (Incl. GST)</th>
    <th style={{ width: 130 }}>Total (Incl. GST)</th>
    <th style={{ width: 40 }}></th>
  </tr>
</thead>
              <tbody>
  {cartList.map((r, i) => (
    <tr key={r.id}>
      <td>{i + 1}</td>
      <td>
        <input
          value={r.name}
          onChange={(e) =>
            setCart((c) => ({
              ...c,
              [r.id]: { ...r, name: e.target.value },
            }))
          }
        />
      </td>
      <td>
        <input
          value={r.specs}
          onChange={(e) =>
            setCart((c) => ({
              ...c,
              [r.id]: { ...r, specs: e.target.value },
            }))
          }
        />
      </td>

      {/* ✅ NEW: GST % cell, only when GST breakdown is ON */}
      {gstBreakdown && (
        <td>
          <GSTRateCell
            id={r.id}
            value={Number.isFinite(r.gst) ? r.gst : 18}
            onChange={(val) =>
              setCart((c) => ({
                ...c,
                [r.id]: { ...r, gst: Number.isFinite(val) ? Number(val) : 0 },
              }))
            }
          />
        </td>
      )}

      <td>
        <input
          type="number"
          value={r.qty}
          min={0}
          onChange={(e) =>
            setCart((c) => ({
              ...c,
              [r.id]: { ...r, qty: Number(e.target.value) },
            }))
          }
        />
      </td>
      <td>
  {/* Existing input box stays the same */}
  <input
    type="number"
    value={r.unit}
    min={0}
    onChange={(e) =>
      setCart((c) => ({
        ...c,
        [r.id]: { ...r, unit: Number(e.target.value) },
      }))
    }
  />

  {/* ✅ NEW — Show “Excl. GST” only when GST breakdown is ON */}
  {gstBreakdown && (
    <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4 }}>
      Excl.: ₹
      {inr(
        (r.unit || 0) /
          (1 + ((Number.isFinite(r.gst) ? r.gst : 18) / 100))
      )}
    </div>
  )}
</td>
      <td style={{ textAlign: "right", fontWeight: 700 }}>
  {/* Existing total: Qty × Unit (inclusive) */}
  ₹{inr((r.qty || 0) * (r.unit || 0))}

  {/* NEW: show excl. GST total when breakdown is ON */}
  {gstBreakdown && (
    <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4, fontWeight: 500 }}>
      Excl.: ₹
      {inr(
        (r.qty || 0) *
          ((r.unit || 0) / (1 + ((Number.isFinite(r.gst) ? r.gst : 18) / 100)))
      )}
    </div>
  )}
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

<tfoot>
  <tr>
    {/* Label spans up to the Total column */}
    <td colSpan={gstBreakdown ? 6 : 5} style={{ textAlign: "right", fontWeight: 700 }}>
      Total (Incl. GST):
    </td>

    {/* Inclusive Total */}
    <td style={{ textAlign: "right", fontWeight: 700 }}>
      ₹{inr(
        cartList.reduce((sum, r) => sum + (r.qty || 0) * (r.unit || 0), 0)
      )}
    </td>

    {/* Empty last cell for the delete/actions column */}
    <td></td>
  </tr>

  {/* Excl. GST row — only when GST breakdown is ON */}
  {gstBreakdown && (
    <tr>
      <td colSpan={6} style={{ textAlign: "right", fontWeight: 700, color: "#6b7280" }}>
        Total (Excl. GST):
      </td>
      <td style={{ textAlign: "right", fontWeight: 700, color: "#6b7280" }}>
        ₹{inr(
          cartList.reduce((sum, r) => {
            const gst = Number.isFinite(r.gst) ? r.gst : 18;
            const excl = (r.unit || 0) / (1 + gst / 100);
            return sum + (r.qty || 0) * excl;
          }, 0)
        )}
      </td>
      <td></td>
    </tr>
  )}
</tfoot>

</table>

{/* Action bar under table */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginTop: 12,
              }}
            >
              <button onClick={addBlankRow}>+ Add Row</button>

              <div style={{ display: "flex", gap: 24 }}>
                <div>
                  Subtotal <b>₹{inr(cartSubtotal)}</b>
                </div>
                <div>
                  Grand Total <b>₹{inr(cartSubtotal)}</b>
                </div>
              </div>
            </div>

            {/* Buttons */}
            <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
              <button
  onClick={async () => {
    const n = await saveQuote();
    if (n && !qHeader.number)
      setQHeader((h) => ({ ...h, number: n }));
  }}
  disabled={!String(qHeader?.number ?? "").trim()}
  title={!String(qHeader?.number ?? "").trim() ? "Assign a quotation code first" : undefined}
>
  Save
</button>
              <button onClick={exportPDFSmart}>Export / Print PDF</button>
              <button onClick={backToCatalog}>Back to Catalog</button>
            </div>
          </div>
        </div>
      )}

{/* PAGE: SAVED DETAILED */}
{page === "savedDetailed" && (
  <div
    style={{
      maxWidth: "min(1240px, 92vw)",
      margin: "12px auto 48px",
      background: "#fff",
      border: "1px solid #e5e7eb",
      borderRadius: 12,
      padding: 20,
    }}
  >
    {/* Top bar */}
    <div
      style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}
    >
      <h2 style={{ margin: 0, flex: "0 0 auto" }}>
  {savedView === "sanctioned" ? "Sanctioned Quotations — HVF" : "Saved Quotations — Detailed View"}
</h2>

      {/* results badge */}
      <span
        style={{
          flex: "0 0 auto",
          fontSize: 12,
          color: "#555",
          background: "#f0f0f0",
          border: "1px solid #e2e2e2",
          borderRadius: 999,
          padding: "3px 8px",
          lineHeight: 1,
        }}
        title="Matching results (respects firm tab + search)"
      >
        {tableData.length} result
{tableData.length === 1 ? "" : "s"}
      </span>

  {/* compact sanctioned summary chip */}
  {savedView === "sanctioned" && sanctionedStats && (
    <span
      style={{
        flex: "0 0 auto",
        fontSize: 12,
        color: "#1f2937",
        background: "#eaf4ff",
        border: "1px solid #d7e7ff",
        borderRadius: 999,
        padding: "3px 10px",
        lineHeight: 1,
        fontWeight: 700,
      }}
      title={`Full: ₹${inr(sanctionedStats.amtFull)} • Partial: ₹${inr(sanctionedStats.amtPartial)} • Total: ₹${inr(sanctionedStats.grand)}`}
    >
      Sanctioned: {sanctionedStats.count} • Full {sanctionedStats.full} • Partial {sanctionedStats.partial} • ₹{inr(sanctionedStats.grand)}
    </span>
  )}

      {/* search input (grows) */}
      <div style={{ position: "relative", flex: "1 1 auto", maxWidth: 420 }}>
        <input
          value={savedSearch}
          onChange={(e) => setSavedSearch(e.target.value)}
          placeholder="Search saved quotes (no., date, customer, phone, items, amount…) "
          style={{
            width: "100%",
            padding: "8px 32px 8px 10px",
            borderRadius: 8,
            border: "1px solid #e5e7eb",
            background: "#fff",
          }}
        />
        {savedSearch && (
          <button
            onClick={() => setSavedSearch("")}
            aria-label="Clear search"
            style={{
              position: "absolute",
              right: 8,
              top: "50%",
              transform: "translateY(-50%)",
              width: 20,
              height: 20,
              borderRadius: "50%",
              border: "none",
              background: "#ccc",
              color: "#fff",
              fontSize: 14,
              lineHeight: "20px",
              textAlign: "center",
              cursor: "pointer",
              padding: 0,
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "#b5b5b5")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "#ccc")}
          >
            ×
          </button>
        )}
      </div>

      {/* Back button */}
      <button
  onClick={() => {
    setSavedView("normal");
    try { localStorage.setItem("hvf.savedview", "normal"); } catch {}
    setPage("catalog");
  }}
  style={{
    flex: "0 0 auto",
    padding: "6px 10px",
    borderRadius: 6,
    border: "1px solid #e5e7eb",
    background: "#f8f9fa",
    cursor: "pointer",
  }}
>
  ← Back to Catalog
</button>
    </div>

    {/* Firm filter tabs + right-aligned Sanctioned toggle */}
<div
  style={{
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
    marginBottom: 12,
    flexWrap: "wrap",
  }}
>
  {/* Left: firm tabs */}
  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
    {[
      { label: "All", value: "All" },
      { label: "HVF Agency", value: "HVF Agency" },
      { label: "Victor Engineering", value: "Victor Engineering" },
      { label: "Mahabir Hardware Stores", value: "Mahabir Hardware Stores" },
      { label: "Internal", value: "Internal" },
    ].map((opt) => {
      const disabledInSanctioned =
        savedView === "sanctioned" && opt.value !== "HVF Agency";

      return (
        <button
          key={opt.value}
          onClick={() => {
            if (disabledInSanctioned) return; // ignore clicks on other firms in sanctioned view
            setSavedFirmFilter(opt.value);
          }}
          disabled={disabledInSanctioned}
          style={{
            padding: "6px 10px",
            borderRadius: 20,
            border: "1px solid #ddd",
            background:
              savedFirmFilter === opt.value
                ? "#1677ff"
                : disabledInSanctioned
                ? "#f3f4f6"
                : "#fff",
            color:
              savedFirmFilter === opt.value
                ? "#fff"
                : disabledInSanctioned
                ? "#9aa0a6"
                : "#333",
            cursor: disabledInSanctioned ? "not-allowed" : "pointer",
            opacity: disabledInSanctioned ? 0.7 : 1,
          }}
          title={
            disabledInSanctioned
              ? "Sanctioned View shows HVF sanctioned quotations only"
              : undefined
          }
        >
          {opt.label}
        </button>
      );
    })}
  </div>

  {/* Right: Sanctioned-only gray pill */}
  <button
  type="button"
  onClick={() => setSavedView((v) => (v === "sanctioned" ? "normal" : "sanctioned"))}
  title="Toggle sanctioned quotations view"
  style={{
    padding: "6px 12px",
    borderRadius: 20,
    border: "1px solid #d0d5dd",
    background: savedView === "sanctioned" ? "#cfd4dc" : "#e9edf3",
    color: "#2b2f33",
    fontWeight: 700,
    cursor: "pointer",
  }}
>
  {savedView === "sanctioned" ? "Sanctioned View • ON" : "Sanctioned View"}
</button>
<button
  type="button"
  onClick={() => {
  setSavedView(v => {
    const next = v === "delivered" ? "normal" : "delivered";
    try { localStorage.setItem("hvf.savedView", next); } catch {}
    return next;
  });
}}
>
  {savedView === "delivered" ? "Delivered • ON" : "Delivered"}
</button>
</div>

   {/* Table (hidden in Delivered view) */}
{savedView !== "delivered" && (
  <div style={{ overflowX: "auto" }}>
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          border: "1px solid #eee",
          fontSize: 14,
        }}
      >
        <thead>
  <tr style={{ background: "#f7f7f7" }}>
    {/* NEW: first column only in sanctioned view */}
    {savedView === "sanctioned" && (
  <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #eee" }}>
    Sanctioned Date
  </th>
)}

{savedView !== "sanctioned" && (
  <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #eee" }}>Firm</th>
)}
<th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #eee" }}>Quotation No.</th>
    <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #eee" }}>Date Created</th>
    <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #eee" }}>Customer</th>
    <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #eee" }}>Address</th>
    <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #eee" }}>Phone</th>
    <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #eee" }}>Items (first 2–3)</th>
    <th style={{ textAlign: "right", padding: 10, borderBottom: "1px solid #eee" }}>Total</th>

    {/* NEW: sanctioned amount column only in sanctioned view */}
    {savedView === "sanctioned" && (
  <th style={{ textAlign: "center", padding: 10, borderBottom: "1px solid #eee" }}>
    Sanctioned Amount
  </th>
)}

{savedView === "sanctioned" && (
  <>
    <th style={{ textAlign: "center", padding: 10, borderBottom: "1px solid #eee" }}>CSM</th>
    <th style={{ textAlign: "center", padding: 10, borderBottom: "1px solid #eee" }}>RTNAD</th>
  </>
)}

{savedView === "sanctioned" && (
  <th style={{ textAlign: "center", padding: 10, borderBottom: "1px solid #eee" }}>
    Undo
  </th>
)}

   {savedView !== "sanctioned" ? (
  <th style={{ textAlign: "center", padding: 10, borderBottom: "1px solid #eee", width: 220 }}>Actions</th>
) : null}

  </tr>
</thead>

       <tbody>
  {(() => {
  let deliveredIdsLS = [];
  try {
    deliveredIdsLS = JSON.parse(localStorage.getItem("hvf.deliveredIds") || "[]");
  } catch {}
  const deliveredIds = Array.from(new Set([...(deliveredIdsLS || []), ...(deliveredIdsDB || [])]));
  const rows = (tableData || []).filter(
    q => !(savedView === "sanctioned" && deliveredIds.includes(q.id))
  );
  return rows;
})().map((q) => {

// Skip rows that are already marked Delivered (so they vanish from Sanctioned view)
const deliveredIdsLS = (() => {
  try { return JSON.parse(localStorage.getItem("hvf.deliveredIds") || "[]"); }
  catch { return []; }
})();
const deliveredIds = Array.from(new Set([...(deliveredIdsLS || []), ...(deliveredIdsDB || [])]));
if (savedView === "sanctioned" && deliveredIds.includes(q.id)) return null;


/* Keep showing delivered rows in All/HVF lists (we only hide inside Sanctioned view above). */
// (no-op)

            const firmName = inferFirmFromNumber(q.number) || "—";
const names = (q.quote_items || [])
  .map((r) => r?.name || "")
  .filter(Boolean);
const shown = names.slice(0, 3);
const extra = Math.max(0, names.length - shown.length);

let dateStr = "";
try {
  if (q.created_at) {
    const d = new Date(q.created_at);
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();
    dateStr = `${dd}/${mm}/${yyyy}`;
  }
} catch {}



// --- Sanctioned helpers (single source of truth) ---
const isHVFRow     = inferFirmFromNumber(q.number) === "HVF Agency";
const isHVFFilter  = savedFirmFilter === "HVF Agency";
const isSanctioned = (q.sanctioned_status || "") === "sanctioned";

const sancMode      = (q.sanctioned_mode || "full").toLowerCase();
const sancIsPartial = sancMode === "partial";

// formatted date for display in the first sanctioned column
const sancDateStr = q.sanctioned_date ? fmtDate(q.sanctioned_date) : "—";

// Delivered badge info (prefer DB; fallback to localStorage). Display as DD/MM/YYYY.
let deliveredDateStr = null;

// 1) Prefer DB column if present
if (q?.delivered_on) {
  try {
    deliveredDateStr = typeof dmy === "function" ? dmy(q.delivered_on) : (typeof fmtDate === "function" ? fmtDate(q.delivered_on) : String(q.delivered_on));
  } catch {
    deliveredDateStr = String(q.delivered_on);
  }
}

// 2) Fallback to localStorage record (legacy path)
if (!deliveredDateStr) {
  try {
    let raw = localStorage.getItem("hvf.deliveredList");
    if (!raw) raw = localStorage.getItem("hvf.delivered");
    if (!raw) raw = localStorage.getItem("hvf_delivered");

    if (raw) {
      const arr = JSON.parse(raw);
      const match = Array.isArray(arr)
        ? arr.find(r => String(r.id ?? r.quote_id) === String(q.id))
        : null;

      const s = match?.delivered_date || match?.date || null;
      if (s) {
        deliveredDateStr = typeof dmy === "function" ? dmy(s) : s;
      }
    }
  } catch {}
}

// No special row background; keep default styling
const rowBg = undefined;

// amount shown in the “Sanctioned Amount” column
const sancAmount = isSanctioned
  ? (sancIsPartial
      ? Number(q.sanctioned_amount || 0)
      : Number(q.total || 0))
  : 0;

            return (
              <tr
  key={q.id}
  style={{
    borderBottom: "1px solid #f0f0f0",
    background: rowBg
  }}
>
  {/* NEW: first column in sanctioned view */}
  {savedView === "sanctioned" && (
<td style={{ padding: 10 }}>
  {sancDateStr}
  {deliveredDateStr && <> &nbsp;•&nbsp; {deliveredDateStr}</>}
</td>
)}

{savedView !== "sanctioned" && (
  <td style={{ padding: 10 }}>{firmName}</td>
)}
<td style={{ padding: 10, fontWeight: 600 }}>
  {inferFirmFromNumber(q.number) === "Internal" ? "—" : q.number}
</td>
                <td style={{ padding: 10 }}>{dateStr}</td>
                <td style={{ padding: 10 }}>{q.customer_name || "—"}</td>
                <td style={{ padding: 10 }}>{q.address || "—"}</td>
                <td style={{ padding: 10 }}>
                  {q.phone ? (
                    <a
                      href={`tel:${(q.phone || "").replace(/[^0-9+]/g, "")}`}
                      style={{ color: "inherit", textDecoration: "underline" }}
                    >
                      {q.phone}
                    </a>
                  ) : (
                    "—"
                  )}
                </td>
                <td style={{ padding: 10 }}>
                  {shown.join(", ")}
                  {extra > 0 ? `, +${extra} more` : ""}
                </td>
                <td style={{ padding: 10, textAlign: "right", fontWeight: 700 }}>
  ₹{inr(q.total || 0)}
</td>

{/* NEW: Sanctioned Amount (only in sanctioned view) */}
{savedView === "sanctioned" && (
  <td style={{ padding: 8, textAlign: "center", verticalAlign: "middle" }}>
  <div style={{ maxWidth: 140, margin: "0 auto" }}>
    {renderSanctionBadge(q)}
  </div>
</td>
)}

{/* CSM editable pill (tiny anchored popover) */}
{savedView === "sanctioned" && (
  <td style={{ padding: 10, textAlign: "center", verticalAlign: "middle" }}>
    <div className="pill-edit-wrap">
      <button
  type="button"
  onClick={(e) => openCSMPop(q, e)}
  onKeyDown={(e) => {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      openCSMPop(q, e);
    }
  }}
  className="badge pill-btn"
  title="Edit CSM amount"
  aria-haspopup="dialog"
  aria-expanded={editingCSM.id === q.id}
  aria-controls={`csm-pop-${q.id}`}
  style={{
          padding: "6px 12px",
          borderRadius: 999,
          cursor: "pointer",
          background: q.csm_amount == null ? "#f3f4f6" : "#eef6ff",
          borderColor: "#d7e7ff",
          fontWeight: 700,
        }}
      >
        {q.csm_amount == null ? "—" : `₹${inr(q.csm_amount)}`}
      </button>
    </div>
  </td>
)}

{/* RTNAD editable pill (final column removed) */}
{savedView === "sanctioned" && (
  <>
    <td style={{ padding: 10, textAlign: "center", verticalAlign: "middle" }}>
      <div
        className="pill-edit-wrap"
        data-row-id={q.id}
        style={{ display: "inline-flex", alignItems: "center", justifyContent: "center" }}
      >
        <button
          type="button"
          onClick={(e) => openRTNADPop(q, e)}
          onKeyDown={(e) => {
            if (e.key === " " || e.key === "Enter") {
              e.preventDefault();
              openRTNADPop(q, e);
            }
          }}
          className="badge pill-btn"
          title="Edit RTNAD amount"
          aria-haspopup="dialog"
          aria-expanded={editingRTNAD.id === q.id}
          aria-controls={`rtnad-pop-${q.id}`}
          style={{
            padding: "6px 12px",
            borderRadius: 999,
            cursor: "pointer",
            background: q.rtnad_amount == null ? "#f3f4f6" : "#eef6ff",
            borderColor: "#d7e7ff",
            fontWeight: 700,
          }}
        >
          {q.rtnad_amount == null ? "—" : `₹${inr(q.rtnad_amount)}`}
        </button>
      </div>
    </td>
  </>
)}

{savedView !== "sanctioned" ? (
  /* -------- NORMAL VIEW: keep your original inline buttons + Status -------- */
  <td style={{ padding: 10, textAlign: "center" }}>
    {/* Top row: Edit / PDF / Delete */}
    <div style={{ display: "flex", justifyContent: "center", gap: 8, flexWrap: "wrap" }}>
      <button
        onClick={() => editSaved(q.number)}
        style={{
          padding: "4px 8px",
          borderRadius: 6,
          border: "1px solid #e5e7eb",
          background: "#fff",
          cursor: "pointer",
        }}
        title="Edit this quote"
      >
        Edit
      </button>

      <button
        onClick={async () => {
          await editSaved(q.number);
          await exportPDF();
        }}
        style={{
          padding: "4px 8px",
          borderRadius: 6,
          border: "1px solid #e5e7eb",
          background: "#f8f9fa",
          cursor: "pointer",
        }}
        title="Open PDF / Print"
      >
        PDF
      </button>

      <button
onClick={() => {
  recycleAdd(q);      // ✅ Step 1: Add quotation to Recycle Bin
  onDeleteQuote(q);   // ✅ Step 2: Continue with existing delete logic
}}
        style={{
          padding: "4px 8px",
          borderRadius: 6,
          border: "1px solid #f3d1d1",
          background: "#fff5f5",
          color: "#b11e1e",
          cursor: "pointer",
        }}
        title="Delete this quote"
      >
        Delete
      </button>
    </div>

    {/* Bottom row: Sanctioned (HVF only) */}
    {(isHVFRow && isHVFFilter && savedView !== "sanctioned") && (
      <div
        style={{
          marginTop: 10,
          paddingTop: 10,
          borderTop: "1px dashed #e5e7eb",
          display: "flex",
          justifyContent: "center",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <button
  type="button"
  onClick={(e) => openStatus(q, e)}
  disabled={isSanctioned}
  hidden={isSanctioned || Boolean(q?.delivered_on || deliveredDateStr)}
  style={{
            padding: "4px 10px",
            borderRadius: 999,
            border: "1px solid #d7e7ff",
            background: isSanctioned ? "#f3f6fb" : "#eaf4ff",
            cursor: isSanctioned ? "not-allowed" : "pointer",
            fontWeight: 700,
            fontSize: 12,
            opacity: isSanctioned ? 0.6 : 1,
          }}
          title={isSanctioned ? "Already sanctioned" : "Set status (full / partial)"}
        >
          Status
        </button>

        {isSanctioned && (
          <span
            className="badge"
            title={
              q.sanctioned_mode === "partial"
                ? `Partial • ₹${inr(q.sanctioned_amount || 0)}`
                : "Full sanction"
            }
            style={{ alignSelf: "center" }}
          >
            Sanctioned • {fmtDate(q.sanctioned_date)}
            {q.sanctioned_mode === "partial"
              ? ` • ₹${inr(q.sanctioned_amount || 0)}`
              : ""}
          </span>
        )}
{deliveredDateStr && (
  <span
    className="badge"
    style={{
      alignSelf: "center",
      background: "#eaf7ea",   // subtle green background
      color: "#155724"         // readable green text
    }}
    title={`Delivered • ${deliveredDateStr}`}
  >
    Delivered • {deliveredDateStr}
  </span>
)}
      </div>
    )}
  </td>
) : (



 /* -------- SANCTIONED VIEW: actions cell (Undo + ⋯) -------- */
<td
  style={{
    padding: 10,
    textAlign: "right",
    position: "relative",
    width: 90,                        // room for both buttons
    borderBottom: "1px solid #eee",
    borderRight: "1px solid #eee"     // closes the right edge
  }}
>
  <div style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
    <button
      type="button"
      onClick={() => unsanctionRow(q.id)}
      className="chip"
      title="Undo sanctioned"
      style={{
        cursor: "pointer",
        borderRadius: 999,
        padding: "4px 10px",
        border: "1px solid #ffdada",
        background: "#fff5f5",
        fontWeight: 700,
        fontSize: 12,
      }}
    >
      ⟲
    </button>

    <button
      type="button"
      className="row-menu-btn"
      aria-label="More actions"
      onClick={(e) => {
        e.stopPropagation();
        openRowMenu(q, e);
      }}
      style={{
        width: 28,
        height: 28,
        borderRadius: "50%",
        border: "1px solid #e5e7eb",
        background: "#fff",
        lineHeight: "26px",
        fontSize: 18,
        cursor: "pointer",
      }}
      title="More"
    >
      ⋯
    </button>
  </div>
</td>
)}
              </tr>
            );
          })}
{(!tableData || tableData.length === 0) && (
  <tr>
    <td
colSpan={savedView === "sanctioned" ? 12 : 9}
      style={{ padding: 20, textAlign: "center", color: "#777" }}
    >
      {emptyMsg}
    </td>
  </tr>
)}
        </tbody>
      </table>
    </div>
)}

    {/* --- Single floating row menu for Sanctioned View (viewport-safe) --- */}
    {savedView === "sanctioned" && rowMenuId && (
      <div
        className="row-menu"
        role="menu"
        style={{
          position: "fixed",
          left: rowMenuPos.x,
          top: rowMenuPos.y,
          width: rowMenuPos.w,
          maxHeight: rowMenuPos.h,
          overflowY: "auto",
          zIndex: 9999,
          background: "#fff",
          border: "1px solid #e5e7eb",
          borderRadius: 12,
          boxShadow: "0 16px 40px rgba(16,24,40,.18)",
          padding: 6,
        }}
      >
        {[
          {
            key: "edit",
            label: "Edit",
            onClick: async () => {
              const row = tableData.find(r => r.id === rowMenuId);
              setRowMenuId(null);
              if (!row) return;
              await editSaved(row.number);
            },
          },
          {
            key: "pdf",
            label: "PDF",
            onClick: async () => {
              const row = tableData.find(r => r.id === rowMenuId);
              setRowMenuId(null);
              if (!row) return;
              await editSaved(row.number);
              await exportPDF();
            },
          },
          {
            key: "remove",
            label: "Remove",
            danger: true,
            onClick: async () => {
              const row = tableData.find(r => r.id === rowMenuId);
              setRowMenuId(null);
              if (!row?.id) return;
              try {
                const { error } = await supabase
                  .from("quotes")
                  .update({
                    sanctioned_status: null,
                    sanctioned_mode:   null,
                    sanctioned_date:   null,
                    sanctioned_amount: null,
                  })
                  .eq("id", row.id);
                if (error) throw error;
                await loadSavedDetailed();
                alert("Removed from Sanctioned ✅");
              } catch (e) {
                alert(e?.message || "Could not remove from Sanctioned.");
              }
            },
          },
        ].map((it) => (
  
          <button
            key={it.key}
            type="button"
            role="menuitem"
            onClick={it.onClick}
            className="rowmenu-item"
            style={{
              display: "flex",
              alignItems: "center",
              width: "100%",
              padding: "10px 12px",
              border: "1px solid transparent",
              borderRadius: 8,
              background: "#fff",
              cursor: "pointer",
              fontWeight: 600,
              color: it.danger ? "#8a1a1a" : "#111827",
              margin: "2px 0",
              textAlign: "left",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = it.danger ? "#fff5f5" : "#f5f7fb";
              e.currentTarget.style.borderColor = "#e5e7eb";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "#fff";
              e.currentTarget.style.borderColor = "transparent";
            }}
          >
            {it.label}
          </button>
        ))}
        {/* Mark as Delivered */}
        <button
          key="deliver"
          type="button"
          role="menuitem"
          onClick={() => {
            const row = tableData.find(r => r.id === rowMenuId);
            setRowMenuId(null);
            if (!row) return;
            openDeliver(row);
          }}
          className="rowmenu-item"
          style={{
            display: "flex",
            alignItems: "center",
            width: "100%",
            padding: "10px 12px",
            border: "1px solid transparent",
            borderRadius: 8,
            background: "#fff",
            cursor: "pointer",
            fontWeight: 600,
            color: "#065f46",         // subtle green text (not danger)
            margin: "2px 0",
            textAlign: "left",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "#f5f7fb";
            e.currentTarget.style.borderColor = "#e5e7eb";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "#fff";
            e.currentTarget.style.borderColor = "transparent";
          }}
        >
          Mark as Delivered
        </button>
      </div>
    )}
  </div>
)}


{/* ===== DELIVERED LIST (simple view) ===== */}
{page === "savedDetailed" && savedView === "delivered" && (
  <div
    className="paper"
    style={{
      width: "100%",
      margin: "0 0 24px 0",
      border: "1px solid #e5e7eb",
      borderRadius: 12,
      padding: 16,
      background: "#fff",
    }}
  >
    <h3 style={{ marginTop: 0, marginBottom: 12 }}>Delivered Quotations</h3>

    {(() => {
      // Always use Supabase-delivered rows (single source of truth)
const base = Array.isArray(deliveredRowsDB) ? deliveredRowsDB : [];

      // Normalize keys so the renderer is consistent
      const rows = base.map((r) => {
        const deliveredRaw =
          r.delivered_on || r.delivered_date || r.date || r.deliveredDate || "";

        // sanitize/resolve amounts from multiple possible keys
        const sanctionedRaw =
          r.sanctioned_amount ??
          r.sanctioned ??
          r.sanction_amount ??
          r.amount ??
          r.sanctionedAmt ??
          null;

        const csmRaw =
          r.csm_amount ?? r.csmAmount ?? r.csm ?? null;

        const rtnadRaw =
          r.rtnad_amount ?? r.rtnadAmount ?? r.rtnad ?? null;

        return {
          id: r.id || r.quote_id || r.number,
          number: r.number || r.quotation_no || r.quote_no || "—",
          customer_name: r.customer_name || r.customer || "—",
          address: r.address || r.customer_address || r.addr || "—",
          phone: r.phone || r.customer_phone || "",
          items: Array.isArray(r.items) ? r.items : (r.items_delivered || []),
delivered_date: (() => {
  const s = String(deliveredRaw || "").trim();
  if (!s) return s;

  // ISO or ISO+time → keep as YYYY-MM-DD
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  // DD/MM/YYYY or MM/DD/YYYY (or with dashes) → normalize to ISO
  m = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if (m) {
    const a = m[1].padStart(2, "0"); // first segment
    const b = m[2].padStart(2, "0"); // second segment
    const y = m[3];

    // We prefer DD/MM by default. If DD/MM is impossible (second >12), treat as MM/DD.
    const dd = parseInt(b, 10) <= 12 ? a : b;
    const mm = parseInt(b, 10) <= 12 ? b : a;

    return `${y}-${mm}-${dd}`; // ISO
  }

  // Fallback: best-effort Date parse → ISO
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) {
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${mm}-${dd}`;
  }
  return s;
})(),
          sanctioned_amount: sanctionedRaw,
          csm_amount: csmRaw,
          rtnad_amount: rtnadRaw,
          remarks: r.remarks || r.adjust || r.delivered_remarks || "",
          total: r.total || r.grand_total || 0,
        };
      });

      // strict DD/MM/YYYY without depending on browser locale
      const dmy = (val) => {
        if (val == null) return "—";
        const s = String(val).trim();
        // ISO: 2025-03-11 or 2025-03-11T...
        const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
        // Try M/D/YYYY or D/M/YYYY → always emit D/M/Y with zero padding
        const any = s.match(/^(\d{1,4})[\/-](\d{1,2})[\/-](\d{1,4})$/);
        if (any) {
          let a = any[1], b = any[2], c = any[3];
          // Heuristic: if first segment is 4 digits, that's year (Y-M-D)
          if (a.length === 4) return `${any[3].padStart(2,"0")}/${any[2].padStart(2,"0")}/${any[1]}`;
          // Otherwise assume M/D/Y and flip to D/M/Y
          const m = a.padStart(2, "0");
          const d = b.padStart(2, "0");
          return `${d}/${m}/${c}`;
        }
        // Last resort: Date parse
        const d = new Date(s);
        if (!Number.isNaN(d.getTime())) {
          const dd = String(d.getDate()).padStart(2, "0");
          const mm = String(d.getMonth() + 1).padStart(2, "0");
          const yy = d.getFullYear();
          return `${dd}/${mm}/${yy}`;
        }
        return s || "—";
      };

      if (rows.length === 0) {
        return <div style={{ color: "#666" }}>No delivered records yet.</div>;
      }

      return (
        <div style={{ overflowX: "visible" }}>
  <table
    style={{
      width: "100%",
      tableLayout: "fixed",
      borderCollapse: "collapse",
      border: "1px solid #eee",
      fontSize: 14,
    }}
  >
            <thead>
              <tr style={{ background: "#f7f7f7" }}>
                <th
  style={{
    textAlign: "left",
    padding: 10,
    borderBottom: "1px solid #eee",
    width: "6%",
  }}
>
  Delivered On
</th>

<th
  style={{
    textAlign: "left",
    padding: 10,
    borderBottom: "1px solid #eee",
    width: "9%",
  }}
>
  Quotation No.
</th>

<th
  style={{
    textAlign: "left",
    padding: 10,
    borderBottom: "1px solid #eee",
    width: "14%",
  }}
>
  Customer
</th>

<th
  style={{
    textAlign: "left",
    padding: 10,
    borderBottom: "1px solid #eee",
    width: "7%",
  }}
>
  Address
</th>

<th
  style={{
    textAlign: "left",
    padding: 10,
    borderBottom: "1px solid #eee",
    width: "8%",
  }}
>
  Phone
</th>

{/* Items — wide */}
<th
  style={{
    textAlign: "left",
    padding: 10,
    borderBottom: "1px solid #eee",
    width: "18%",
  }}
>
  Items
</th>

<th
  style={{
    textAlign: "right",
    padding: 10,
    borderBottom: "1px solid #eee",
    width: "8%",
  }}
>
  Sanctioned
</th>

{/* Remarks — wide */}
<th
  style={{
    textAlign: "left",
    padding: 10,
    borderBottom: "1px solid #eee",
    width: "14%",
  }}
>
  Remarks
</th>

<th
  style={{
    textAlign: "right",
    padding: 10,
    borderBottom: "1px solid #eee",
    width: "6%",
  }}
>
  CSM
</th>

<th
  style={{
    textAlign: "right",
    padding: 10,
    borderBottom: "1px solid #eee",
    width: "5%",
  }}
>
  RTNAD
</th>

<th
  style={{
    textAlign: "right",
    padding: 10,
    borderBottom: "1px solid #eee",
    width: "5%",
  }}
>
  Actions
</th>
              </tr>
            </thead>

            <tbody>
              {rows.map((row) => {
                const dstr = dmy(row.delivered_date);

                // items: show first 2, then +N
                const names = (row.items || []).map((it) =>
                  typeof it === "string" ? it : (it?.name || "")
                ).filter(Boolean);
                const firstTwo = names.slice(0, 2).join(", ");
                const extra = names.length > 2 ? ` +${names.length - 2} more` : "";
                const itemsText = names.length ? (firstTwo + extra) : "—";

                // amounts
                const sancAmt  = row.sanctioned_amount;
                const csmAmt   = row.csm_amount;
                const rtnadAmt = row.rtnad_amount;

                return (
                  <tr key={row.id} style={{ borderBottom: "1px solid #f0f0f0" }}>
                    {/* Delivered On */}
                    <td style={{ padding: 10 }}>
  {(() => {
    const s0 = String(row?.delivered_date ?? "").trim();
    if (!s0) return "—";

    // ISO (YYYY-MM-DD or YYYY-MM-DDTHH:mm)
    let m = s0.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[3]}/${m[2]}/${m[1]}`; // DD/MM/YYYY

    // D/M/YYYY or M/D/YYYY or with dashes
    m = s0.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
    if (m) {
      const a = m[1].padStart(2, "0");
      const b = m[2].padStart(2, "0");
      const y = m[3];
      // Heuristic: if first part > 12, it must be the day
      const day = parseInt(a, 10) > 12 ? a : b;
      const mon = parseInt(a, 10) > 12 ? b : a;
      return `${day}/${mon}/${y}`;
    }

    // Last resort: Date()
    const d = new Date(s0);
    if (!Number.isNaN(d.getTime())) {
      const dd = String(d.getDate()).padStart(2, "0");
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const yy = d.getFullYear();
      return `${dd}/${mm}/${yy}`;
    }
    return s0;
  })()}
</td>
                    {/* Quotation No. */}
                    <td style={{ padding: 10, fontWeight: 600 }}>{row.number || "—"}</td>

                    {/* Customer */}
                    <td style={{ padding: 10 }}>{row.customer_name || "—"}</td>

                    {/* Address */}
                    <td style={{ padding: 10 }}>{row.address || "—"}</td>

                    {/* Phone */}
<td
  style={{
    padding: 10,
    whiteSpace: "nowrap",
  }}
>
  {row.phone ? (
    <a
      href={`tel:${String(row.phone).replace(/[^0-9+]/g, "")}`}
      style={{ color: "inherit", textDecoration: "underline" }}
    >
      {row.phone}
    </a>
  ) : "—"}
</td>

                    {/* Items */}
<td
  style={{
    padding: 10,
    whiteSpace: "normal",
    wordBreak: "break-word",
  }}
>
  {itemsText}
</td>

                    {/* Sanctioned */}
<td style={{ padding: 10, textAlign: "right" }}>
  {(() => {
    const v =
      row?.sanctioned_amount ??
      row?.sanction_amount ??
      row?.amount ??
      row?.sanctionedAmount ??
      row?.sanctioned_amt ??
      row?.sanctioned ??
      null;

    if (v === null || v === undefined || v === "") return "—";
    const n = Number(String(v).replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) ? `₹${inr(n)}` : "—";
  })()}
</td>

{/* Remarks */}
<td
  style={{
    padding: 10,
    whiteSpace: "normal",
    wordBreak: "break-word",
  }}
>
  {row.remarks || "—"}
</td>

{/* CSM */}
<td style={{ padding: 10, textAlign: "right" }}>
  {csmAmt != null ? `₹${inr(Number(csmAmt) || 0)}` : "—"}
</td>

                    {/* RTNAD */}
                    <td style={{ padding: 10, textAlign: "right" }}>
                      {rtnadAmt != null ? `₹${inr(Number(rtnadAmt) || 0)}` : "—"}
                    </td>

                    {/* Actions */}
<td style={{ padding: "10px 16px 10px 10px", textAlign: "right" }}>
  <button
    onClick={async () => {
                          // Try DB first, then local fallback
                          try {
                            if (typeof dbDeleteDelivered === "function") {
                              await dbDeleteDelivered(row.id);
                              await (typeof dbFetchDelivered === "function" ? dbFetchDelivered() : Promise.resolve());
                            }
                          } catch (e) {
                            console.warn("dbDeleteDelivered failed, falling back to local", e);
                          }
                          try { unmarkDeliveredById(row.id); } catch {}
                          setSavedView("delivered");
                          try { localStorage.setItem("hvf.savedView", "delivered"); } catch {}
                        }}
                        style={{
                          padding: "6px 10px",
                          borderRadius: 8,
                          border: "1px solid #ddd",
                          background: "#fff",
                          cursor: "pointer",
                        }}
                        title="Move back to Sanctioned"
                      >
                        Undo
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      );
    })()}
  </div>
)}

{/* ===== DELIVERED LIST (local) ===== */}
{savedView === "delivered" && false && (() => {
  // SAFETY: tolerate undefined/missing helper or bad shape
  let list = [];
  try {
    const out = typeof getDeliveredList === "function" ? getDeliveredList() : [];
    list = Array.isArray(out) ? out : [];
  } catch {
    list = [];
  }

  return (
    <div
      style={{
        border: "1px solid #eee",
        borderRadius: 12,
        padding: 12,
        marginTop: 8,
      }}
    >
      {/* duplicate Delivered list removed */}

    </div>
  );
})()}


{/* ===== DELIVER DIALOG (large) ===== */}
{deliverPop?.open && (
  <div
    style={{
      position: "fixed",
      inset: 0,
      background: "rgba(0,0,0,0.35)",
      zIndex: 60,
      display: "flex",
      alignItems: "flex-start",
      justifyContent: "center",
      padding: "48px 24px",
      overflow: "auto"
    }}
    onClick={(e) => {
      if (e.target === e.currentTarget) setDeliverPop({ open: false, row: null });
    }}
  >
    <div
      style={{
        width: "min(1200px, 94vw)",
        background: "#fff",
        borderRadius: 12,
        boxShadow: "0 20px 60px rgba(0,0,0,.25)",
        padding: 24
      }}
    >
      <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>Mark as Delivered</h2>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
  <button
    type="button"
    onClick={() => setDeliverPop({ open: false, row: null })}
    style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid #ddd", background: "#fff" }}
  >
    Cancel
  </button>
  <button
    type="button"
    onClick={saveDeliverLocal}
    style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #0a7", background: "#0a7", color: "#fff" }}
  >
    Save
  </button>
</div>
      </div>

      {/* Top row: date + sanctioned/CSM/RTNAD */}
      <div style={{ display: "grid", gridTemplateColumns: "220px 1fr", gap: 16, marginBottom: 16 }}>
        <label style={{ display: "grid", gap: 6 }}>
          <span style={{ fontSize: 13, color: "#555" }}>Delivery date</span>
          <input
            type="date"
            value={deliverForm.date || new Date().toISOString().slice(0,10)}
            onChange={(e) => setDeliverForm((f) => ({ ...f, date: e.target.value }))}
            style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #ddd" }}
          />
        </label>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
          <label style={{ display: "grid", gap: 6 }}>
            <span style={{ fontSize: 13, color: "#555" }}>Sanctioned (shown)</span>
            <input
              type="text"
              readOnly
              value={deliverForm.sanctioned ?? ""}
              style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #eee", background: "#fafafa" }}
            />
          </label>
          <label style={{ display: "grid", gap: 6 }}>
            <span style={{ fontSize: 13, color: "#555" }}>CSM amount</span>
            <input
              type="text"
              value={deliverForm.csm ?? ""}
              onChange={(e) => setDeliverForm((f) => ({ ...f, csm: e.target.value }))}
              style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #ddd" }}
            />
          </label>
          <label style={{ display: "grid", gap: 6 }}>
            <span style={{ fontSize: 13, color: "#555" }}>RTNAD amount</span>
            <input
              type="text"
              value={deliverForm.rtnad ?? ""}
              onChange={(e) => setDeliverForm((f) => ({ ...f, rtnad: e.target.value }))}
              style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #ddd" }}
            />
          </label>
        </div>
      </div>

      {/* Items table */}
      <div style={{ marginTop: 4 }}>
        <div style={{ fontSize: 13, color: "#555", marginBottom: 8 }}>Items delivered</div>
        <div style={{ border: "1px solid #eee", borderRadius: 10, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "#fafafa" }}>
                <th style={{ textAlign: "left", padding: "10px 12px", borderBottom: "1px solid #eee" }}>Deliver</th>
                <th style={{ textAlign: "left", padding: "10px 12px", borderBottom: "1px solid #eee" }}>Item name</th>
                <th style={{ width: 60, padding: "10px 12px", borderBottom: "1px solid #eee" }}></th>
              </tr>
            </thead>
            <tbody>
              {(deliverForm.items || []).map((it, idx) => (
                <tr key={idx}>
                  <td style={{ padding: "8px 12px", borderBottom: "1px solid #f3f3f3" }}>
                    <input
                      type="checkbox"
                      checked={!!it.delivered}
                      onChange={(e) =>
                        setDeliverForm((f) => {
                          const items = [...(f.items || [])];
                          items[idx] = { ...items[idx], delivered: e.target.checked };
                          return { ...f, items };
                        })
                      }
                    />
                  </td>
                  <td style={{ padding: "8px 12px", borderBottom: "1px solid #f3f3f3" }}>
                    <input
                      type="text"
                      value={it.name || ""}
                      onChange={(e) =>
                        setDeliverForm((f) => {
                          const items = [...(f.items || [])];
                          items[idx] = { ...items[idx], name: e.target.value };
                          return { ...f, items };
                        })
                      }
                      style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "1px solid #ddd" }}
                    />
                  </td>
                  <td style={{ padding: "8px 12px", borderBottom: "1px solid #f3f3f3" }}>
                    <button
                      onClick={() =>
                        setDeliverForm((f) => {
                          const items = [...(f.items || [])];
                          items.splice(idx, 1);
                          return { ...f, items };
                        })
                      }
                      title="Remove item"
                      style={{ border: "1px solid #eee", background: "#fff", borderRadius: 8, padding: "6px 10px" }}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
              {(!deliverForm.items || deliverForm.items.length === 0) && (
                <tr>
                  <td colSpan={3} style={{ padding: 16, color: "#777" }}>No items</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Remarks */}
      <div style={{ marginTop: 16 }}>
        <div style={{ fontSize: 13, color: "#555", marginBottom: 6 }}>Other adjustments / remarks (optional)</div>
        <textarea
          rows={3}
          value={deliverForm.adjust || ""}
          onChange={(e) => setDeliverForm((f) => ({ ...f, adjust: e.target.value }))}
          style={{ width: "100%", padding: "10px 12px", borderRadius: 10, border: "1px solid #ddd" }}
          placeholder="Add any notes or manual adjustments…"
        />
      </div>
    </div>
  </div>
)}
{/* ===== /DELIVER DIALOG ===== */}

{/* ======= CSM / RTNAD MINI POPOVERS (fixed; no scrolling needed) ======= */}
<BodyPortal>
  {csmPop.open && (
  <div
    id={`csm-pop-${editingCSM.id}`}
    className="pill-pop"
    role="dialog"
    aria-modal="true"
    tabIndex={-1}
    onKeyDown={(e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setEditingCSM({ id: null, value: "" });
        setCSMPop(p => ({ ...p, open: false }));
      }
    }}
    style={{
        position: "fixed",
        left: csmPop.x,
        top: csmPop.y,
        transform: csmPop.above ? "translate(-50%,-100%)" : "translate(-50%,0)",
        width: 220,
        background: "#fff",
        borderRadius: 12,
        boxShadow: "0 12px 28px rgba(0,0,0,.14)",
        padding: 12,
        zIndex: 4000,
        border: "1px solid rgba(0,0,0,.06)"
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <input
  id={`csm-input-${editingCSM.id}`}
  autoFocus
  type="number"
  placeholder="Amount"
  value={editingCSM.value}
        onChange={(e) => setEditingCSM((s) => ({ ...s, value: e.target.value }))}
        onKeyDown={(e) => handleInlineKeyCSM(e, editingCSM.id)}
        style={{ width: "100%", height: 36, borderRadius: 8, border: "1px solid #ddd", padding: "0 10px" }}
      />
      <div style={{ display: "flex", gap: 8, marginTop: 8, justifyContent: "flex-end" }}>
        <button
          disabled={savingInline || editingCSM.id == null}
          onClick={() => saveCSM(editingCSM.id)}
          style={{ height: 32, padding: "0 12px", borderRadius: 8 }}
        >
          OK
        </button>
        <button
          onClick={() => { setEditingCSM({ id: null, value: "" }); setCSMPop(p => ({ ...p, open: false })); }}
          style={{ height: 32, padding: "0 12px", borderRadius: 8 }}
        >
          Cancel
        </button>
      </div>
    </div>
  )}

  {rtnadPop.open && (
  <div
    id={`rtnad-pop-${editingRTNAD.id}`}
    className="pill-pop"
    role="dialog"
    aria-modal="true"
    tabIndex={-1}
    onKeyDown={(e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setEditingRTNAD({ id: null, value: "" });
        setRTNADPop(p => ({ ...p, open: false }));
      }
    }}
    style={{
        position: "fixed",
        left: rtnadPop.x,
        top: rtnadPop.y,
        transform: rtnadPop.above ? "translate(-50%,-100%)" : "translate(-50%,0)",
        width: 220,
        background: "#fff",
        borderRadius: 12,
        boxShadow: "0 12px 28px rgba(0,0,0,.14)",
        padding: 12,
        zIndex: 4000,
        border: "1px solid rgba(0,0,0,.06)"
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <input
  id={`rtnad-input-${editingRTNAD.id}`}
  autoFocus
  type="number"
  placeholder="Amount"
  value={editingRTNAD.value}
        onChange={(e) => setEditingRTNAD((s) => ({ ...s, value: e.target.value }))}
        onKeyDown={(e) => handleInlineKeyRTNAD(e, editingRTNAD.id)}
        style={{ width: "100%", height: 36, borderRadius: 8, border: "1px solid #ddd", padding: "0 10px" }}
      />
      <div style={{ display: "flex", gap: 8, marginTop: 8, justifyContent: "flex-end" }}>
        <button
          disabled={savingInline || editingRTNAD.id == null}
          onClick={() => saveRTNAD(editingRTNAD.id)}
          style={{ height: 32, padding: "0 12px", borderRadius: 8 }}
        >
          OK
        </button>
        <button
          onClick={() => { setEditingRTNAD({ id: null, value: "" }); setRTNADPop(p => ({ ...p, open: false })); }}
          style={{ height: 32, padding: "0 12px", borderRadius: 8 }}
        >
          Cancel
        </button>
      </div>
    </div>
  )}
</BodyPortal>

{/* ========= DELIVER MODAL (large dialog shell) ========= */}


{/* Status Popover (small anchored panel) */}
{statusPop.open && (
  <>
    {/* transparent backdrop to close on outside click */}
    <div
      onClick={closeStatus}
      style={{ position: "fixed", inset: 0, background: "transparent", zIndex: 9998 }}
    />
    <div
      className="paper"
      role="dialog"
      aria-label="Set status"
      style={{
        position: "absolute",
        left: statusPop.x,
        top: statusPop.y + 6,
        zIndex: 9999,
        width: 320,
        border: "1px solid #e5e7eb",
        borderRadius: 12,
        boxShadow: "0 12px 36px rgba(16,24,40,.12)",
        background: "#fff",
      }}
    >
      <div className="section" style={{ borderBottom: "1px solid #eee" }}>
        <div style={{ fontWeight: 700 }}>Status</div>
        <div className="muted" style={{ marginTop: 4, fontSize: 12 }}>
          {statusPop.row?.number} — {statusPop.row?.customer_name || "—"}
        </div>
      </div>

      <div className="section" style={{ display: "grid", gap: 10 }}>
        {/* Date */}
        <label>
          <div style={{ fontSize: 12, color: "#666" }}>Date *</div>
          <input
            type="date"
            value={statusForm.date}
            onChange={(e) => setStatusForm((f) => ({ ...f, date: e.target.value }))}
          />
        </label>

        {/* Full / Partial */}
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <label className="chip" style={{ cursor: "pointer" }}>
            <input
              type="radio"
              name="status_mode"
              checked={statusForm.mode === "full"}
              onChange={() => setStatusForm((f) => ({ ...f, mode: "full", amount: "" }))}
              style={{ marginRight: 8 }}
            />
            Full (₹{inr(statusPop.row?.total || 0)})
          </label>

          <label className="chip" style={{ cursor: "pointer" }}>
  <input
    type="radio"
    name="status_mode"
    checked={statusForm.mode === "partial"}
    onChange={() => {
      const total = Number(statusPop?.row?.total || 0);
      const half  = total ? Math.round(total * 0.5) : "";
      setStatusForm((f) => ({ ...f, mode: "partial", amount: String(half) }));
    }}
    style={{ marginRight: 8 }}
  />
  Partial
</label>
        </div>

        {/* Amount (only if Partial) */}
       {statusForm.mode === "partial" && (
  <div>
    <label>
      <div style={{ fontSize: 12, color: "#666" }}>Partial Amount *</div>
      <input
        type="number"
        inputMode="decimal"
        min="0"
        step="0.01"
        placeholder="Enter amount (₹)"
        value={statusForm.amount}
        onChange={(e) => setStatusForm((f) => ({ ...f, amount: e.target.value }))}
      />
    </label>

    {/* quick picks */}
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
      {[
        { label: "25%", frac: 0.25 },
        { label: "50%", frac: 0.50 },
        { label: "75%", frac: 0.75 },
        { label: "Max", frac: 1.00 },
        { label: "Clear", frac: null },
      ].map((opt) => (
        <button
          key={opt.label}
          type="button"
          onClick={() => {
            if (opt.frac == null) {
              setStatusForm((f) => ({ ...f, amount: "" }));
              return;
            }
            const total = Number(statusPop?.row?.total || 0);
            const val = total ? Math.round(total * opt.frac) : 0;
            setStatusForm((f) => ({ ...f, amount: String(val) }));
          }}
          className="chip"
          style={{
            cursor: "pointer",
            borderRadius: 999,
            padding: "4px 10px",
            border: "1px solid #d7e7ff",
            background: "#eaf4ff",
            fontWeight: 700,
            fontSize: 12,
          }}
          title={
            opt.frac != null
              ? (() => {
                  const total = Number(statusPop?.row?.total || 0);
                  const val = total ? Math.round(total * opt.frac) : 0;
                  return `₹${inr(val)} of ₹${inr(total)}`;
                })()
              : "Clear amount"
          }
        >
          {opt.label}
        </button>
      ))}
    </div>
  </div>
)}

        {/* Error */}
        {statusErr && <div style={{ color: "#b11e1e", fontSize: 13 }}>{statusErr}</div>}
      </div>

      <div className="section" style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button className="btn" type="button" onClick={closeStatus} disabled={savingStatus}>
          Cancel
        </button>
        <button className="btn primary" type="button" onClick={saveStatus} disabled={savingStatus}>
          {savingStatus ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  </>
)}

{/* TOP-LEFT: global Undo */}
<div
  style={{
    position: "fixed",
    left: 12,
    top: 12,
    zIndex: 10001,
  }}
>
  <button
    type="button"
    onClick={onUndo}
    disabled={!canUndo}
    className="btn"
    style={{
      padding: "6px 10px",
      borderRadius: 8,
      border: "1px solid #ddd",
      background: "#fff",
      opacity: canUndo ? 1 : 0.5,
      cursor: canUndo ? "pointer" : "default",
    }}
    title={canUndo ? "Undo last action" : "Nothing to undo yet"}
  >
    ⟲ Undo
  </button>
</div>

{/* FLOATING bottom-right controls */}
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
      onClick={startNewQuote}
      title="Start a fresh quotation"
      className="btn primary"
    >
      + New Quote
    </button>
  )}

  {quoteMode && (
    <button onClick={goToEditor} className="btn">
      View Quote ({cartCount})
    </button>
  )}

  {quoteMode && (
    <button onClick={openSavedDetail} className="btn">
      Saved Quotes
    </button>
  )}
</div>

{/* FLOATING bottom-left: Recycle Bin (only on Saved Detailed View) */}
{page === "savedDetailed" && Array.isArray(tableData) && (
  <div
    style={{
      position: "fixed",
      left: 16,
      bottom: 16,
      zIndex: 20,
    }}
  >
    <button
      type="button"
      onClick={() => setRecycleOpen(true)}
      className="btn"
      title="Open Recycle Bin"
      style={{
        padding: "8px 10px",
        borderRadius: 999,
        border: "1px solid #ddd",
        background: "#fff",
        display: "flex",
        alignItems: "center",
        gap: 6,
      }}
    >
      <span aria-hidden>🗑️</span>
      <span>Recycle Bin</span>
    </button>
  </div>
)}

{/* end floating controls */}

{/* ================= RECYCLE BIN PANEL ================= */}
{recycleOpen && page === "savedDetailed" && (() => {
  // Read the bin safely from localStorage every render of the panel
  let bin = [];
  try {
    bin = JSON.parse(localStorage.getItem("hvf.recycleBin") || "[]");
    if (!Array.isArray(bin)) bin = [];
  } catch { bin = []; }

  return (
    <div
      style={{
        position: "fixed",
        left: 16,
        bottom: 72,
        width: 400,
        maxHeight: "70vh",
        overflowY: "auto",
        background: "#fff",
        border: "1px solid #ddd",
        borderRadius: 12,
        boxShadow: "0 12px 32px rgba(0,0,0,0.15)",
        zIndex: 3000,
        padding: 16,
      }}
    >
      {/* Panel Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h3 style={{ margin: 0 }}>🗑️ Recycle Bin</h3>
        <button
          onClick={() => setRecycleOpen(false)}
          style={{
            border: "none",
            background: "transparent",
            fontSize: 20,
            cursor: "pointer",
          }}
          title="Close"
        >
          ✕
        </button>
      </div>

      <hr style={{ margin: "12px 0" }} />

      {/* Empty state */}
      {bin.length === 0 ? (
        <div style={{ color: "#666", fontSize: 14 }}>No deleted quotations.</div>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
          <thead>
            <tr style={{ background: "#f7f7f7" }}>
              <th style={{ textAlign: "left",  padding: 8 }}>Quote No.</th>
              <th style={{ textAlign: "left",  padding: 8 }}>Customer</th>
              <th style={{ textAlign: "right", padding: 8 }}>Amount</th>
              <th style={{ textAlign: "center",padding: 8 }}>Restore</th>
            </tr>
          </thead>
          <tbody>
            {bin.map((item, idx) => {
              const q = item?.quote || {};
              return (
                <tr key={idx}>
                  <td style={{ padding: 8, borderBottom: "1px solid #f3f4f6" }}>
                    {q.number || "—"}
                  </td>
                  <td style={{ padding: 8, borderBottom: "1px solid #f3f4f6" }}>
                    {q.customer_name || "—"}
                  </td>
                  <td style={{ padding: 8, textAlign: "right", borderBottom: "1px solid #f3f4f6" }}>
                    ₹{inr(Number(q.total || 0))}
                  </td>
                  <td style={{ padding: 8, textAlign: "center", borderBottom: "1px solid #f3f4f6" }}>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => onRestoreRecycle(idx)}
                      style={{
                        padding: "4px 8px",
                        border: "1px solid #ccc",
                        borderRadius: 6,
                        background: "#fff",
                        cursor: "pointer",
                      }}
                      title="Restore this quote"
                    >
                      ⟲ Restore
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
})()}

{/* end root container (now inside the <div> children, valid JSX) */}
</div>
);
}