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

const CATEGORIES = [
  "Rice mills and machines",
  "Food processing machinery",
  "Coding and packaging machinery",
  "Power Tools",
  "Lawn and Garden Tools",
  "Weeders and tillers",
  "Other machinery",
];

/* --- App --- */
export default function App() {
  const [items, setItems] = useState([]);
  const [category, setCategory] = useState("All");
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");

  const [session, setSession] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loginEmail, setLoginEmail] = useState("");
  const [showLogin, setShowLogin] = useState(false);

  const [form, setForm] = useState({
    name: "",
    category: "",
    mrp: "",
    sell_price: "",
    cost_price: "",
    specs: "",
    imageFile: null,
  });

  /* --- Auth: read session and is_admin --- */
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

  /* --- Data: load machines --- */
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

  useEffect(() => {
    loadMachines();
  }, []);

  /* --- Filters --- */
  const filtered = useMemo(() => {
    if (category === "All") return items;
    return items.filter(
      (m) => (m.category || "").toLowerCase() === category.toLowerCase()
    );
  }, [items, category]);

  /* --- Auth actions --- */
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

  /* --- Form handlers --- */
  const onChange = (e) => {
    const { name, value, files } = e.target;
    if (files) setForm((f) => ({ ...f, imageFile: files[0] || null }));
    else setForm((f) => ({ ...f, [name]: value }));
  };

  const [saving, setSaving] = useState(false);

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

  /* --- UI --- */
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

        {/* Auth Row */}
        <div style={{ marginTop: 8 }}>
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

      {/* Admin Add Form */}
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
              {CATEGORIES.map((c) => (
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
        {["All", ...CATEGORIES].map((c) => (
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
                <div
                  style={{
                    height: 240,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: "#fff",
                    padding: 8,
                    borderBottom: "1px solid #eee",
                  }}
                >
                  {m.image_url && (
                    <img
                      src={m.image_url}
                      alt={m.name}
                      loading="lazy"
                      onError={(e) =>
                        (e.currentTarget.style.display = "none")
                      }
                      style={{
                        maxWidth: "100%",
                        maxHeight: "100%",
                        width: "auto",
                        height: "auto",
                        objectFit: "contain",
                        display: "block",
                      }}
                    />
                  )}
                </div>
                <div className="card-body">
                  <h3>{m.name}</h3>
                  {m.specs && <p style={{ color: "#666" }}>{m.specs}</p>}
                  <p style={{ fontWeight: 700 }}>
  ₹{formatINRnoDecimals(m.mrp)}
</p>
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