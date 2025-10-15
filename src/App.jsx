
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

/** Compress an image file WITHOUT changing pixel dimensions.
 * Tries WebP first (for smaller size); if browser can’t, falls back to JPEG.
 * Returns { blob, filename, mime }.
 */
async function compressImageKeepSize(file, quality = 0.82) {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);

  // detect webp support in current browser/canvas
  const webpTest = canvas.toDataURL("image/webp").startsWith("data:image/webp");
  const tryMime = webpTest ? "image/webp" : "image/jpeg";
  const ext = webpTest ? ".webp" : ".jpg";

  const blob = await new Promise((resolve) =>
    canvas.toBlob((b) => resolve(b), tryMime, quality)
  );

  const base = file.name.replace(/\.[^.]+$/g, "");
  return { blob, filename: `${base}${ext}`, mime: tryMime };
}

/** Compress an arbitrary image Blob to JPEG (keeps pixel dimensions).
 * Used for already-uploaded images so we can overwrite same .jpg/.png path safely.
 */
async function compressBlobToJpeg(blob, quality = 0.82) {
  const img = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);
  return await new Promise((resolve) =>
    canvas.toBlob((b) => resolve(b), "image/jpeg", quality)
  );
}

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
  const [loginEmail, setLoginEmail] = useState("");
  const [showLogin, setShowLogin] = useState(false);

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

  // optimize existing
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

  const onSave = async (e) => {
    e.preventDefault();
    if (!isAdmin) return alert("Admins only.");
    if (!form.name || !form.category || !form.mrp || !form.imageFile) {
      return alert("Name, Category, MRP and Image are required.");
    }

    setSaving(true);
    try {
      // 1) compress WITHOUT changing dimensions (client-side)
      const compressed = await compressImageKeepSize(form.imageFile, 0.82);

      // 2) upload image (safe filename)
      const safeBase = form.name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .slice(0, 40);
      // keep original extension logic based on the compressed mime
      const ext = compressed.mime === "image/webp" ? "webp" : "jpg";
      const filePath = `products/${Date.now()}-${safeBase}.${ext}`;

      const { error: upErr } = await supabase.storage
        .from("images")
        .upload(filePath, compressed.blob, {
          cacheControl: "3600",
          contentType: compressed.mime,
          upsert: true,
        });
      if (upErr) throw new Error("UPLOAD: " + upErr.message);

      const { data: urlData, error: urlErr } = supabase.storage
        .from("images")
        .getPublicUrl(filePath);
      if (urlErr) throw new Error("URL: " + urlErr.message);
      const image_url = urlData.publicUrl;

      // 3) insert record
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
      alert("Product added ✅ (image optimized)");
    } catch (err) {
      console.error(err);
      alert("Failed to add product: " + err.message);
    } finally {
      setSaving(false);
    }
  };

  /* ---------- optimize existing images (admin) ---------- */
  const optimizeAllImages = async () => {
    if (!isAdmin) return alert("Admins only.");
    if (!confirm("Optimize all existing product images now?")) return;

    setOptimizing(true);
    let ok = 0,
      fail = 0;

    // This prefix lets us recover the storage path from the public URL
    const publicPrefix = `${supabaseUrl}/storage/v1/object/public/images/`;

    for (const m of items) {
      try {
        if (!m.image_url || !m.image_url.startsWith(publicPrefix)) continue;

        const relPath = m.image_url.slice(publicPrefix.length); // e.g. products/123-name.jpg
        // 1) download current image
        const res = await fetch(m.image_url, { cache: "no-cache" });
        if (!res.ok) throw new Error(`fetch ${res.status}`);
        const blob = await res.blob();

        // 2) recompress to JPEG (keep dimensions) so we can safely overwrite same path
        const jpegBlob = await compressBlobToJpeg(blob, 0.82);

        // 3) upload with upsert to overwrite in place (same URL keeps working)
        const { error: upErr } = await supabase.storage
          .from("images")
          .upload(relPath, jpegBlob, {
            upsert: true,
            contentType: "image/jpeg",
            cacheControl: "3600",
          });
        if (upErr) throw upErr;
        ok++;
      } catch (e) {
        console.error("Optimize failed for", m.image_url, e);
        fail++;
      }
    }

    setOptimizing(false);
    alert(`Optimization finished. Success: ${ok}${fail ? `, Failed: ${fail}` : ""}`);
    // No DB changes needed; same URLs.
    await loadMachines();
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
      {/* Header */}
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

        {/* Auth Row (Admin + Staff quick view) */}
        <div style={{ marginTop: 8 }}>
          {/* Staff toggle always visible */}
          <button
            onClick={toggleStaffLogin}
            style={{
              marginRight: 8,
              background: staffMode ? "#ffeaea" : "#f1f1f1",
              color: staffMode ? "#b30000" : "#333",
            }}
          >
            {staffMode ? "Logout Staff View" : "Login as Staff (PIN)"}
          </button>

          {session ? (
            <>
              <button onClick={signOut} style={{ marginRight: 8 }}>
                Sign Out
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
              <span style={{ color: "#777", fontSize: 12 }}>
                UID: {session.user?.id?.slice(0, 8)}…
              </span>
            </>
          ) : (
            <div style={{ display: "inline-flex", gap: 8 }}>
              {!showLogin ? (
                <button
                  onClick={() => setShowLogin(true)}
                  style={{
                    backgroundColor: "#333",
                    color: "#fff",
                    padding: "6px 12px",
                    borderRadius: 6,
                    cursor: "pointer",
                  }}
                >
                  Login as Admin
                </button>
              ) : (
                <>
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
                  <button
                    onClick={() => setShowLogin(false)}
                    style={{ marginLeft: 6 }}
                  >
                    Cancel
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Admin tools row */}
      {isAdmin && (
        <div
          style={{
            maxWidth: 1100,
            margin: "0 auto 10px",
            display: "flex",
            justifyContent: "space-between",
            gap: 8,
          }}
        >
          <button onClick={onAddCategory}>+ Add Category</button>
          <button onClick={optimizing ? undefined : optimizeAllImages} disabled={optimizing}>
            {optimizing ? "Optimizing images…" : "Optimize existing images"}
          </button>
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