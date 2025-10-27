import React, { useLayoutEffect, useEffect, useMemo, useState, useRef } from "react";
import { createClient } from "@supabase/supabase-js";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

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

const inferFirmFromNumber = (num) => {
  if (!num) return null;
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
  const { data, error } = await supabase.rpc("next_quote_number", { p_firm: firm });
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
  const content = 'width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover, interactive-widget=resizes-content';

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
useEffect(() => {
  if (page === "savedDetailed") {
    setSavedFirmFilter("All");
    loadSavedDetailed();
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

  // 2) Otherwise, reserve a NEW number from Supabase (increments the counter)
  try {
    const { data, error } = await supabase.rpc("next_quote_number", {
      p_firm: firm,
    });
    if (error || !data) throw error || new Error("No number returned");
    const today = todayStr();
    setQHeader((h) => ({ ...h, number: data, date: today }));
    setSavedOnce(false); // brand new number, not saved yet
    return data;
  } catch (e) {
    console.error("Could not get next number from Supabase RPC:", e);
    alert(
      "Could not fetch the next quotation number. Please check your internet and try again."
    );
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

  /* ---------- SAVE USING YOUR SCHEMA (quotes + quote_items) ---------- */
const saveQuote = async (forceNumber) => {
  try {
    // 1) Ensure/reuse the correct firm number
    const number = forceNumber ?? (await ensureFirmNumber());

    // 2) Header payload
    const header = {
      number,
      customer_name: qHeader.customer_name || null,
      address: qHeader.address || null,
      phone: qHeader.phone || null,
      subject: qHeader.subject || null,
      total: cartSubtotal,
    };

    // 3) UPSERT by unique "number" (avoids duplicate-key error)
    const { data: up, error: upErr } = await supabase
      .from("quotes")
      .upsert(header, { onConflict: "number" })   // <— KEY CHANGE
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
    setQHeader((h) => ({ ...h, number: up.number }));
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
const [savedFirmFilter, setSavedFirmFilter] = useState("All"); // "All" | "HVF Agency" | "Victor Engineering" | "Mahabir Hardware Stores"
const [savedSearch, setSavedSearch] = useState("");

// Format ISO date to DD/MM/YYYY
const fmtDate = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
};


// computed list used by the Detailed page table (respects firm tab + search box) — SAFE
const savedDetailedFiltered = useMemo(() => {
  const list = Array.isArray(savedDetailed) ? savedDetailed : [];

  // firm tab filter
  const byFirm =
    savedFirmFilter === "All"
      ? list
      : list.filter((q) => (inferFirmFromNumber(q?.number) || "") === savedFirmFilter);

  const q = (savedSearch || "").trim().toLowerCase();
  if (!q) return byFirm;

  // helper to stringify safely
  const text = (v) => (v == null ? "" : String(v));

  return byFirm.filter((row) => {
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
      // if anything odd slips in, never crash—just keep the row
      return true;
    }
  });
}, [savedDetailed, savedFirmFilter, savedSearch]);

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
const loadSavedDetailed = async () => {
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
        quote_items:quote_items ( name )
      `)
      .order("created_at", { ascending: false });

    if (error) throw error;

    // Attach first 2–3 item names as a preview for each quote
    const enriched = (data || []).map((q) => {
      const names = (q.quote_items || []).map((it) => it?.name || "");
      return {
        ...q,
        _itemsPreview: names.slice(0, 3),
        _itemsTotal: names.length,
      };
    });

    setSavedDetailed(enriched);
  } catch (err) {
    console.error("loadSavedDetailed failed:", err);
    alert(`Could not load saved quotes (detailed).\n${err?.message || err}`);
    setSavedDetailed([]);
  }
};

// Open the full-screen detailed view
const goToSavedDetailed = async () => {
  await loadSavedDetailed();
  setPage("savedDetailed");
};

const openSavedDetail = async () => {
  const pop = document.getElementById("saved-pop");
  if (pop) pop.style.display = "none";
  setSavedFirmFilter("All");
  await loadSavedDetailed();
  setPage("savedDetailed");  // <-- correct page key
};

// Load one saved quote into the editor
const editSaved = async (number) => {
  try {
    // 1) Header
   const { data: q, error: qerr } = await supabase
  .from("quotes")
  .select("id,number,customer_name,address,phone,subject") // include address (+ subject if present)
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

setEditingQuoteId(q.id);   // <-- remember which quote row we’re editing
setSavedOnce(true);        // <-- this quote already exists in DB

    setQuoteMode(true);
    setPage("quoteEditor");
  } catch (err) {
    console.error("editSaved failed:", err);
    alert(`Could not load the saved quote.\n${err?.message || err}`);
  }
};

// Delete a saved quote (header + items) and then rewind that firm's counter
const deleteSavedQuote = async (number) => {
  if (!number) return;
  const ok = confirm(`Delete quote ${number}? This cannot be undone.`);
  if (!ok) return;

  try {
    // 1) Which firm?
    const firmOfQuote = inferFirmFromNumber(number);
    if (!firmOfQuote) throw new Error(`Cannot infer firm from number: ${number}`);

    // 2) Find quote id
    const { data: q, error: qerr } = await supabase
      .from("quotes")
      .select("id")
      .eq("number", number)
      .maybeSingle();
    if (qerr) throw qerr;
    if (!q?.id) throw new Error(`Quote not found: ${number}`);

    // 3) Delete items first (FK safety)
    const { error: ierr } = await supabase
      .from("quote_items")
      .delete()
      .eq("quote_id", q.id);
    if (ierr) throw ierr;

    // 4) Delete header
    const { error: derr } = await supabase
      .from("quotes")
      .delete()
      .eq("id", q.id);
    if (derr) throw derr;

    // 5) Rewind that firm's counter to the current max in quotes
    const { error: rpcErr } = await supabase.rpc("sync_counter_to_max", {
      p_firm: firmOfQuote,
    });
    if (rpcErr) throw rpcErr;

    // 6) Update UI lists immediately so the row vanishes without a refresh
setSaved((arr) => (arr || []).filter((r) => r.number !== number));
setSavedDetailed((arr) => (arr || []).filter((r) => r.number !== number));

// (Optional) also refresh the small popup list in background
loadSaved();

// If the editor currently shows this number, clear it
if (qHeader.number === number) {
  setQHeader((h) => ({ ...h, number: "" }));
  setSavedOnce(false);
}

    alert(`Deleted ${number} ✅`);
  } catch (err) {
    console.error("deleteSavedQuote failed:", err);
    alert(`Delete failed: ${err?.message || err}`);
  }
};

 /* ---------- CLEAN PDF (NOT web print) ---------- */
const exportPDF = async () => {
  if (cartList.length === 0) return alert("Nothing to print.");

  // Always use today for editor + PDF
  const dateStr = todayStr();
  setQHeader((h) => ({ ...h, date: dateStr }));

  // Reserve/ensure the number once for editor, PDF & DB (no fallbacks)
  let number;
  try {
    number = await ensureFirmNumber(); // throws & alerts if RPC fails
  } catch {
    return; // abort PDF if reservation failed
  }

  // Always save (UPSERT). It’s safe and avoids duplicate-key errors.
try {
  const savedNum = await saveQuote(number);
  if (!savedNum) return;
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

  if (firm === "HVF Agency") {
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
    const frameBottom = ph - 40;
    const frameH = frameBottom - frameTop;
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
    doc.text(`GSTIN  : 18BCYCP9744A1ZA`, rx, frameTop + 52); // update if needed

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
  const body = cartList.map((r, i) => [
    String(i + 1),
    `${r.name || ""}${r.specs ? `\n(${r.specs})` : ""}`,
    String(r.qty || 0),
    inr(r.unit || 0),
    inr((r.qty || 0) * (r.unit || 0)),
  ]);

  const colSl = 28;
  const colQty = 40;
  const colUnit = 90;
  const colTotal = 110;
  const colDesc = Math.max(
    120,
    contentW - (colSl + colQty + colUnit + colTotal)
  );

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

    // preserve your two-line Description + custom 2nd line
    didParseCell: (data) => {
      if (data.section !== "body") return;
      if (data.column.index !== 1) return;
      const raw = (data.cell.raw ?? "").toString();
      const nl = raw.indexOf("\n(");
      if (nl === -1) return;
      const name = raw.slice(0, nl);
      const specs = raw.slice(nl);
      data.cell.text = [name, " "];
      data.cell._specs = specs;
    },

    didDrawCell: (data) => {
      if (data.section !== "body") return;
      if (data.column.index !== 1) return;
      const specs = data.cell && data.cell._specs;
      if (!specs) return;

      const cellPad = (side) => {
        if (typeof data.cell.padding === "function")
          return data.cell.padding(side);
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
      const lineH = fsMain * 1.15;
      const specsY = data.cell.y + padTop + lineH;

      const maxW = data.cell.width - padLeft - padRight;
      const wrapped = doc.splitTextToSize(specs, maxW);

      const prevSize = doc.getFontSize();
      doc.setFontSize(prevSize * 0.85);
      doc.setTextColor(120);
      doc.text(wrapped, x, specsY);
      doc.setTextColor(0, 0, 0);
      doc.setFontSize(prevSize);
    },
  });

  // -------------------------------
// TOTAL LINE (stick right under the table)
// -------------------------------
const at = doc.lastAutoTable || null;
const totalsRightX = R - 10;
const totalsY = (at?.finalY ?? afterHeaderY) + 18; // always right after table

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

  if (firm === "Victor Engineering") {
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

    // BANK section — NO rectangle
    const bankTop = ty + termsH + 10;
    doc.setFont("times", "bold");
    doc.setFontSize(11);
    doc.text("BANK DETAILS", L + 10, bankTop + 16);

    doc.setFont("times", "normal");
    doc.setFontSize(10);
    doc.text(
      [
        "M/S VICTOR ENGINEERING",
        "Axis Bank (Moran, 785670)",
        "Current Account",
        "A/C No: 921020019081364",
        "IFSC: UTIB0003701",
      ],
      L + 10,
      bankTop + 34
    );

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
        "This quotation is valid for one month from the date of issue.",
        "Delivery is subject to stock availability and may take up to 2 weeks.",
        "Goods once sold are non-returnable and non-exchangeable.",
        "",
        "Yours Faithfully",
        firm === "Mahabir Hardware Stores" ? "Mahabir Hardware Stores" : "HVF Agency",
        firm === "Mahabir Hardware Stores" ? "—" : "9957239143 / 9954425780",
        firm === "Mahabir Hardware Stores" ? "GST: —" : "GST: 18AFCPC4260P1ZB",
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
        "MAHABIR HARDWARE STORES",
        "SBI (Moranhat Branch)",
        "A/C No - 302187654321",
        "IFSC Code - SBIN0001995",
      ];
    }
    doc.text(bankLines, L, ty + 136);
  }

  // Done — open in new tab
  window.open(doc.output("bloburl"), "_blank");
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
        --bg: #f7f9fc;
        --paper: #ffffff;
        --text: #1f2937;
        --muted: #6b7280;
        --border: #e5e7eb;
        --primary: #1677ff;
        --radius: 10px;
        --shadow: 0 6px 24px rgba(16,24,40,.06);
        --ring: 0 0 0 3px rgba(22,119,255,.18);
        --space-1: 6px; --space-2: 8px; --space-3: 12px; --space-4: 16px; --space-5: 20px;
      }
            html, body {
        -webkit-text-size-adjust: 100%;
        text-size-adjust: 100%;
      }
      html, body { -webkit-text-size-adjust: 100%; }

body {
  color: var(--text);
  background: linear-gradient(180deg,var(--bg),#eef2f7);
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue",
               Arial, "Noto Sans", "Liberation Sans", sans-serif;
}

      .container { max-width:1100px; margin:0 auto; }
      .paper { background:var(--paper); border:1px solid var(--border); border-radius:var(--radius); box-shadow:var(--shadow); }
      .section { padding: var(--space-4); }
      .muted { color: var(--muted); }
      .title { margin:0; font-weight:800; letter-spacing:.2px; }

      .btn { padding:6px 12px; border-radius:6px; border:1px solid var(--border); background:#f8f9fa; cursor:pointer; font-weight:600; }
      .btn:hover { background:#eef1f5; }
      .btn.primary { background:var(--primary); border-color:var(--primary); color:#fff; }
      .btn.danger { background:#fff5f5; border-color:#f3d1d1; color:#b11e1e; }

      .chip { padding:6px 10px; border:1px solid var(--border); border-radius:20px; background:#fff; color:#333; }
      .chip.active { background:var(--primary); color:#fff; border-color:var(--primary); }

      input, select, textarea { padding:6px 10px; border:1px solid var(--border); border-radius:6px; outline:none; width:100%; max-width:100%; box-sizing:border-box; }
input:focus, select:focus, textarea:focus { box-shadow: var(--ring); border-color: var(--primary); }

/* iOS Safari: prevent auto-zoom on focus (inputs <16px trigger zoom). */
/* Prevent iOS Safari auto-zoom when focusing inputs */
input, select, textarea { font-size: 16px !important; }

      table { width:100%; border-collapse:collapse; font-size:14px; }
      th, td { padding:10px; border-bottom:1px solid var(--border); }
      thead th { background:#f7f7f7; position:sticky; top:0; z-index:1; }
      tr:hover td { background:#fafbff; }

      .badge { font-size:12px; color:#555; background:#f0f0f0; border:1px solid #e2e2e2; border-radius:999px; padding:3px 8px; line-height:1; }

      /* Catalog cards polish */
      .card {
        background: var(--paper);
        border: 1px solid var(--border);
        border-radius: var(--radius);
        box-shadow: var(--shadow);
        overflow: hidden;
        transition: transform .08s ease, box-shadow .2s ease, border-color .2s ease;

        /* NEW: stretch to row height & make a column layout so the Add bar can stick to bottom */
        height: 100%;
        display: flex;
        flex-direction: column;
      }
      .card:hover {
        transform: translateY(-2px);
        box-shadow: 0 12px 36px rgba(16,24,40,.08);
        border-color: #d7dbe3;
      }
      .card-body{
  padding: var(--space-4);
  /* fill remaining vertical space under the image */
  display:flex;
  flex-direction:column;
  flex:1;
}

/* MOBILE ONLY: equalize the text area height so the Add bar lines up */
@media (max-width:640px){
  .card{ display:flex; flex-direction:column; }   /* make the whole card a column */
  .card-body{ min-height:230px; }                 /* reserve room for varying text */
  .addbar{ margin-top:auto; padding-bottom:10px;} /* stick Add bar at the bottom */
}
/* Mobile only: keep the Add/Counter bar aligned at the bottom of each card */
@media (max-width: 640px){
  /* Make the catalog a real grid on phones and stretch items so each
     row uses the tallest card's height (keeps Add bars aligned). */
  .catalog-grid{
    display: grid !important;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
    align-items: stretch;     /* equal height per row */
  }

  .card{
    display: flex;
    flex-direction: column;
    height: 100%;             /* fill the stretched row height */
  }

  .card-body{
    flex: 1;
    display: flex;
    flex-direction: column;
  }

  /* Pin the Add/Counter bar to the bottom inside each card */
  .addbar{
    margin-top: auto;
    padding-bottom: 10px;
  }
}
  /* product name: clamp to 2 lines */
.card-body .pname{
  margin: 0 0 6px;
  font-size: 16px;
  font-weight: 700;
  line-height: 1.25;
  min-height: calc(1.25em * 2); /* reserve exactly 2 lines */
  display: -webkit-box;
  -webkit-line-clamp: 2;        /* clamp to 2 lines */
  -webkit-box-orient: vertical;
  overflow: hidden;
  text-overflow: ellipsis;
}
      .thumb { background: #fff; }

/* clamp specs/description to 2 lines */
.card-body .specs{
  color:#666;
  margin: 0 0 6px;
  line-height: 1.35;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  text-overflow: ellipsis;
}

      /* nicer number inputs */
      input[type=number]::-webkit-outer-spin-button,
      input[type=number]::-webkit-inner-spin-button{ -webkit-appearance:none; margin:0; }
      input[type=number]{ -moz-appearance:textfield; }

/* --- Centered Add / Counter bar for cards --- */
.addbar{ margin-top:auto; display:flex; justify-content:center; width:100%; }
.addbtn, .qtywrap{
  width:74%;           /* 92% → 74% (≈20% smaller) */
  max-width:224px;     /* 280px → 224px (also 20% smaller) */
  height:44px;
  border-radius:10px;
  border:1.5px solid var(--primary);
  display:flex; align-items:center; justify-content:center;
  font-weight:700;
  transition:background .15s ease, color .15s ease, box-shadow .15s ease;
}

/* initial “Add” button */
.addbtn{ background:#fff; color:var(--primary); font-size:108%; }
.addbtn:hover{ background:var(--primary); color:#fff; box-shadow:var(--ring); }

/* counter bar (appears after first click) */
.qtywrap{ background:var(--primary); color:#fff; gap:14px; padding:0 12px; }
.qtywrap .op{
  width:44px; height:44px; display:flex; align-items:center; justify-content:center;
  font-size:20px; border:none; background:transparent; color:#fff; cursor:pointer;
}
.qtywrap .op:active{ transform:scale(.96); }
.qtywrap .num{
  min-width:76px; height:34px; line-height:34px; text-align:center;
  background:#fff; color:var(--primary); border-radius:6px; font-weight:800;
}

/* --- Mobile-only fix: keep full counter visible, no cut-off --- */
@media (max-width: 640px){
  .addbar{ margin-top:10px; }
  .addbtn, .qtywrap{
    width:92%;          /* wider on phones so - 1 + fit */
    max-width:340px;    /* allow wider if the card allows */
    height:42px;        /* a touch shorter */
  }
  .qtywrap{ gap:10px; padding:0 8px; }
  .qtywrap .op{ width:38px; height:42px; font-size:22px; }
  .qtywrap .num{ min-width:64px; height:32px; line-height:32px; }
}

/* ===== Categories: mobile strip vs desktop wrap ===== */

/* Phones (single-row, swipeable; hide scrollbar) */
@media (max-width: 640px){
  .cat-strip{
    display: flex !important;
    flex-wrap: nowrap !important;
    overflow-x: auto !important;
    -webkit-overflow-scrolling: touch;
    touch-action: pan-x;
    overscroll-behavior-x: contain;
    padding-bottom: 6px;
    scroll-snap-type: x proximity;
    scroll-padding-inline: 12px;   /* allow first/last chip to center */
    gap: 8px;
  }
  .cat-strip::-webkit-scrollbar{ display:none; }  /* iOS/Chrome */
  .cat-strip{ scrollbar-width: none; }            /* Firefox */

  .cat-strip .chip{
    flex: 0 0 auto;
    min-width: 160px;
    max-width: 260px;
    white-space: normal;   /* allow two lines */
    line-height: 1.2;
    text-align: center;
    scroll-snap-align: center;   /* center each chip on stop */
  }
}

/* Desktop & tablets (revert to centered wrap like before) */
@media (min-width: 641px){
  .cat-strip{
    display: flex !important;
    flex-wrap: wrap !important;
    justify-content: center !important;
    gap: 8px !important;
    overflow: visible !important;
    padding-bottom: 0 !important;
    scroll-snap-type: none !important;
  }
  .cat-strip .chip{
    min-width: auto !important;
    max-width: none !important;
    white-space: nowrap !important;
    padding: 6px 10px !important;
    border-radius: 20px !important;
  }
}


/* Desktop: restore 3 columns */
@media (min-width: 641px){
  .addform-grid{
    grid-template-columns: 1fr 1fr 1fr;
  }
}
    

/* Prevent any wide control (esp. file input) from pushing the form sideways */
.addform-grid label{ display:block; min-width:0; }
.addform-grid label > *{ max-width:100%; }
.addform-grid input[type="file"]{ width:100%; }

@media (max-width:640px){
  html, body{ max-width:100%; overflow-x:hidden; }
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
      style={{ width: 192, height: "auto", marginBottom: 8 }} // 160 → 192 (+20%)
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
)}

<div>Date: {qHeader.date}</div>
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
                  <th style={{ width: 80 }}>Qty</th>
                  <th style={{ width: 120 }}>Unit Price</th>
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
              >
                Save
              </button>
              <button onClick={exportPDF}>Export / Print PDF</button>
              <button onClick={backToCatalog}>Back to Catalog</button>
            </div>
          </div>
        </div>
      )}

{/* PAGE: SAVED DETAILED */}
{page === "savedDetailed" && (
  <div
    style={{
      maxWidth: 1100,
      margin: "0 auto 40px",
      background: "#fff",
      border: "1px solid #e5e7eb",
      borderRadius: 12,
      padding: 16,
    }}
  >

    {/* Top bar */}
<div
  style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}
>
  <h2 style={{ margin: 0, flex: "0 0 auto" }}>
    Saved Quotations — Detailed View
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
    {savedDetailedFiltered.length} result
    {savedDetailedFiltered.length === 1 ? "" : "s"}
  </span>

  {/* search input (grows) */}
  <div style={{ position: "relative", flex: "1 1 auto", maxWidth: 420 }}>
    <input
      value={savedSearch}
      onChange={(e) => setSavedSearch(e.target.value)}
      placeholder="Search saved quotes (no., date, customer, phone, items, amount…) "
      style={{
        width: "100%",
        padding: "8px 32px 8px 10px", // room for clear button
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

  {/* Back button stays inside this flex bar */}
  <button
    onClick={() => setPage("catalog")}
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
    {/* Firm filter tabs */}
<div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
  {[
    { label: "All", value: "All" },
    { label: "HVF Agency", value: "HVF Agency" },
    { label: "Victor Engineering", value: "Victor Engineering" },
    { label: "Mahabir Hardware Stores", value: "Mahabir Hardware Stores" },
  ].map((opt) => (
    <button
      key={opt.value}
      onClick={() => setSavedFirmFilter(opt.value)}
      style={{
        padding: "6px 10px",
        borderRadius: 20,
        border: "1px solid #ddd",
        background: savedFirmFilter === opt.value ? "#1677ff" : "#fff",
        color: savedFirmFilter === opt.value ? "#fff" : "#333",
        cursor: "pointer",
      }}
    >
      {opt.label}
    </button>
  ))}
</div>

    {/* Table */}
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
            <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #eee" }}>Firm</th>
            <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #eee" }}>Quotation No.</th>
            <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #eee" }}>Date Created</th>
            <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #eee" }}>Customer</th>
            <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #eee" }}>Address</th>
            <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #eee" }}>Phone</th>
            <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #eee" }}>Items (first 2–3)</th>
            <th style={{ textAlign: "right", padding: 10, borderBottom: "1px solid #eee" }}>Total</th>
            <th style={{ textAlign: "center", padding: 10, borderBottom: "1px solid #eee", width: 220 }}>Actions</th>
          </tr>
        </thead>

        <tbody>
          {(savedDetailedFiltered || []).map((q) => {
            const firmName = inferFirmFromNumber(q.number) || "—";

            // first few item names
            const names = (q.quote_items || []).map((r) => r?.name || "").filter(Boolean);
            const shown = names.slice(0, 3);
            const extra = Math.max(0, names.length - shown.length);

            // format date from created_at
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

            return (
              <tr key={q.id} style={{ borderBottom: "1px solid #f0f0f0" }}>
                <td style={{ padding: 10 }}>{firmName}</td>
                <td style={{ padding: 10, fontWeight: 600 }}>{q.number}</td>
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
  ) : "—"}
</td>
                <td style={{ padding: 10 }}>
                  {shown.join(", ")}
                  {extra > 0 ? `, +${extra} more` : ""}
                </td>
                <td style={{ padding: 10, textAlign: "right", fontWeight: 700 }}>₹{inr(q.total || 0)}</td>
                <td style={{ padding: 10, textAlign: "center" }}>
                  <div style={{ display: "inline-flex", gap: 8, flexWrap: "wrap" }}>
                    <button
                      onClick={() => editSaved(q.number)}
                      style={{ padding: "4px 8px", borderRadius: 6, border: "1px solid #e5e7eb", background: "#fff", cursor: "pointer" }}
                      title="Edit this quote"
                    >
                      Edit
                    </button>
                    <button
                      onClick={async () => { await editSaved(q.number); await exportPDF(); }}
                      style={{ padding: "4px 8px", borderRadius: 6, border: "1px solid #e5e7eb", background: "#f8f9fa", cursor: "pointer" }}
                      title="Open PDF / Print"
                    >
                      PDF
                    </button>
                    <button
                      onClick={() => deleteSavedQuote(q.number)}
                      style={{ padding: "4px 8px", borderRadius: 6, border: "1px solid #f3d1d1", background: "#fff5f5", color: "#b11e1e", cursor: "pointer" }}
                      title="Delete this quote"
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
          {(!savedDetailedFiltered || savedDetailedFiltered.length === 0) && (
            <tr>
              <td colSpan={9} style={{ padding: 20, textAlign: "center", color: "#777" }}>
                No saved quotations found.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  </div>
)}

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
  <button
    onClick={goToEditor}
    className="btn"
  >
    View Quote ({cartCount})
  </button>
)}

{quoteMode && (
  <button
    onClick={() => {
      loadSaved();
      document.getElementById("saved-pop").style.display = "block";
    }}
    className="btn"
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
        <div
  style={{
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 6,
    gap: 8,
  }}
>
  <b>Saved Quotes</b>

  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
    <button
      onClick={openSavedDetail}
      title="Open a full-page list of all saved quotations"
      style={{
        padding: "4px 8px",
        borderRadius: 6,
        border: "1px solid #e5e7eb",
        background: "#f8f9fa",
        cursor: "pointer",
      }}
    >
      Show detailed view
    </button>

    <button
      onClick={() =>
        (document.getElementById("saved-pop").style.display = "none")
      }
      style={{
        padding: "4px 8px",
        borderRadius: 6,
        border: "1px solid #e5e7eb",
        background: "#fff",
        cursor: "pointer",
      }}
      aria-label="Close"
    >
      ✕
    </button>
  </div>
</div>
        {saved.length === 0 ? (
          <div style={{ color: "#777" }}>No saved quotes yet.</div>
        ) : (
          saved.map((q) => (
            <div
              key={q.number}
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
                <div>
                  <b>{q.number}</b> — {q.customer_name || "—"}
                </div>
                <div style={{ fontSize: 12, color: "#666" }}>
                  ₹{inr(q.total || 0)}
                </div>
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
  <button
    onClick={() => deleteSavedQuote(q.number)}
    style={{ borderColor: "#f3d1d1", color: "#b11e1e", background: "#fff5f5" }}
    title="Delete this quote"
  >
    Delete
  </button>
</div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}