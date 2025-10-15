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

/* --- App --- */
export default function App() {
  // data
  const [items, setItems] = useState([]);
  const [categories, setCategories] = useState([]); // dynamic
  const [category, setCategory] = useState("All");

  // ui / status
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");

  // auth
  const [session, setSession] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);

  // login UI (top-right)
  const [loginEmail, setLoginEmail] = useState("");
  const [showLoginMenu, setShowLoginMenu] = useState(false);
  const [showAdminBox, setShowAdminBox] = useState(false); // reveal email input inside menu

  // staff quick view (PIN 2525)
  const [staffMode, setStaffMode] = useState(false);
  const toggleStaffLogin = () => {
    if (staffMode) {
      setStaffMode(false);
      return;
    }
    const pin = prompt("Enter staff PIN:");
    if ((pin || "").trim() === "2525") setStaffMode(true);
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

  // (optional) existing-image optimizer state from earlier version
  const [optimizing, setOptimizing] = useState(false);

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
      // tidy the menu when auth changes
      setShowLoginMenu(false);
      setShowAdminBox(false);
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
    setShowLoginMenu(false);
    setShowAdminBox(false);
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
    if (category === "All") return items;
    return items.filter(
      (m) => (m.category || "").toLowerCase() === category.toLowerCase()
    );
  }, [items, category]);

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

  // (keeps earlier on-upload compression if you had it; otherwise native upload)
  async function compressImageKeepSize(file, quality = 0.82) {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);

    const webpOk = canvas.toDataURL("image/webp").startsWith("data:image/webp");
    const mime = webpOk ? "image/webp" : "image/jpeg";
    return await new Promise((resolve) =>
      canvas.toBlob((b) => resolve(b), mime, quality)
    );
  }

  const onSave = async (e) => {
    e.preventDefault();
    if (!isAdmin) return alert("Admins only.");
    if (!form.name || !form.category || !form.mrp || !form.imageFile) {
      return alert("Name, Category, MRP and Image are required.");
    }

    setSaving(true);
    try {
      // --- compress client-side without changing dimensions (safe to remove if not needed) ---
      const compressedBlob = await compressImageKeepSize(form.imageFile, 0.82);
      const ext = compressedBlob.type === "image/webp" ? "webp" : "jpg";

      // 1) upload image (safe filename)
      const safeBase = form.name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .slice(0, 40);
      const filePath = `products/${Date.now()}-${safeBase}.${ext}`;

      const { error: upErr } = await supabase.storage
        .from("images")
        .upload(filePath, compressedBlob, {
          cacheControl: "3600",
          contentType: compressedBlob.type,
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

  /* ---------- UI ---------- */
  return (
    <div
      style={{
        fontFamily: "Arial, sans-serif",
        minHeight: "100vh",
        background: "linear-gradient(to bottom right,#f8f9fa,#eef2f7)",
        position: "relative",
      }}
    >
      {/* TOP-RIGHT LOGIN AREA */}
      <div
        style={{
          position: "fixed",
          top: 16, // decent gap from the top
          right: 16, // decent gap from the right
          zIndex: 1000,
        }}
      >
        {!session ? (
          <div style={{ position: "relative" }}>
            <button
              onClick={() => {
                setShowLoginMenu((s) => !s);
                setShowAdminBox(false);
              }}
              style={{
                backgroundColor: "#333",
                color: "#fff",
                padding: "8px 14px",
                borderRadius: 8,
                cursor: "pointer",
                border: "1px solid #222",
              }}
            >
              Login
            </button>

            {showLoginMenu && (
              <div
                style={{
                  position: "absolute",
                  top: 44,
                  right: 0,
                  background: "#fff",
                  border: "1px solid #e5e7eb",
                  borderRadius: 10,
                  boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
                  width: 280,
                  padding: 10,
                }}
              >
                {/* Staff quick login */}
                <button
                  onClick={toggleStaffLogin}
                  style={{
                    width: "100%",
                    padding: "8px 10px",
                    borderRadius: 8,
                    border: "1px solid #ddd",
                    background: staffMode ? "#ffeaea" : "#f9f9f9",
                    color: staffMode ? "#b30000" : "#333",
                    marginBottom: 8,
                    cursor: "pointer",
                  }}
                >
                  {staffMode ? "Logout Staff View" : "Login as Staff (PIN)"}
                </button>

                {/* Admin login */}
                {!showAdminBox ? (
                  <button
                    onClick={() => setShowAdminBox(true)}
                    style={{
                      width: "100%",
                      padding: "8px 10px",
                      borderRadius: 8,
                      border: "1px solid #ddd",
                      background: "#f9f9f9",
                      color: "#333",
                      cursor: "pointer",
                    }}
                  >
                    Login as Admin
                  </button>
                ) : (
                  <div style={{ display: "grid", gap: 8 }}>
                    <input
                      type="email"
                      placeholder="your@email.com"
                      value={loginEmail}
                      onChange={(e) => setLoginEmail(e.target.value)}
                      style={{
                        padding: "8px 10px",
                        borderRadius: 8,
                        border: "1px solid #ddd",
                      }}
                    />
                    <div style={{ display: "flex", gap: 6 }}>
                      <button
                        onClick={sendLoginLink}
                        style={{
                          flex: 1,
                          padding: "8px 10px",
                          borderRadius: 8,
                          border: "1px solid #1677ff",
                          background: "#1677ff",
                          color: "#fff",
                          cursor: "pointer",
                        }}
                      >
                        Send Login Link
                      </button>
                      <button
                        onClick={() => setShowAdminBox(false)}
                        style={{
                          padding: "8px 10px",
                          borderRadius: 8,
                          border: "1px solid #ddd",
                          background: "#fff",
                          color: "#333",
                          cursor: "pointer",
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          // When logged in (admin session)
          <div
            style={{
              display: "flex",
              gap: 8,
              alignItems: "center",
              background: "#fff",
              border: "1px solid #e5e7eb",
              borderRadius: 10,
              padding: "6px 8px",
              boxShadow: "0 8px 24px rgba(0,0,0,0.06)",
            }}
          >
            <span
              style={{
                padding: "4px 8px",
                borderRadius: 6,
                background: isAdmin ? "#e8f6ed" : "#f7e8e8",
                color: isAdmin ? "#1f7a3f" : "#b11e1e",
                fontSize: 12,
              }}
            >
              {isAdmin ? "Admin: ON" : "Not admin"}
            </span>
            <button
              onClick={signOut}
              style={{
                background: "#f9f9f9",
                color: "#333",
                padding: "6px 10px",
                borderRadius: 8,
                cursor: "pointer",
                border: "1px solid #ddd",
              }}
            >
              Sign Out
            </button>
          </div>
        )}
      </div>

      {/* Header (centered brand) */}
      <div style={{ textAlign: "center", marginBottom: 18, paddingTop: 12 }}>
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

      {/* Admin tools row */}
      {isAdmin && (
        <div
          style={{
            maxWidth: 1100,
            margin: "0 auto 10px",
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
          }}
        >
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

      {/* Product grid */}
      <div style={{ maxWidth: 1100, margin: "0 auto 40px" }}>
        {loading ? (
          <p style={{ textAlign: "center" }}>Loading…</p>
        ) : (
          <div className="catalog-grid">
            {filtered.map((m) => (
              <div key={m.id} className="card">
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
                  <p style={{ fontWeight: 700 }}>₹{formatINRnoDecimals(m.mrp)}</p>

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

                      {/* For Admin only, show slash + Cost (yellow) */}
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
                    <p style={{ color: "#777", fontSize: 12 }}>{m.category}</p>
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
    </div>
  );
}