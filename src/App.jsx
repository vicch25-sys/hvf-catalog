import React, { useLayoutEffect, useEffect, useMemo, useState, useRef } from "react";
import * as XLSX from "xlsx";
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

function HistoricalSalaryPaymentEditDialog({
  editInfo,
  onClose,
  onSave,
}) {
  const payment = editInfo?.payment || {};

  const [
    salaryPeriodFrom,
    setSalaryPeriodFrom,
  ] = useState(payment.salaryPeriodFrom || "");

  const [
    salaryPeriodTo,
    setSalaryPeriodTo,
  ] = useState(payment.salaryPeriodTo || "");

  const [
    paymentDate,
    setPaymentDate,
  ] = useState(payment.paymentDate || "");

  const [amount, setAmount] = useState(
    String(payment.amount || "")
  );

  const [
    paymentMode,
    setPaymentMode,
  ] = useState(payment.paymentMode || "Cash");

  const [remarks, setRemarks] = useState(
    payment.remarks || ""
  );

  const formatEditDate = (dateValue) =>
    dateValue
      ? String(dateValue)
          .split("-")
          .reverse()
          .join("-")
      : "—";

  const handleSave = () => {
    if (
      !salaryPeriodFrom ||
      !salaryPeriodTo ||
      !paymentDate
    ) {
      alert(
        "Salary Period From, Salary Period To and Payment Date are required."
      );
      return;
    }

    if (salaryPeriodFrom > salaryPeriodTo) {
      alert(
        "Salary Period From cannot be later than Salary Period To."
      );
      return;
    }

    const numericAmount = Number(
      String(amount).replace(/,/g, "")
    );

    if (
      !Number.isFinite(numericAmount) ||
      numericAmount <= 0
    ) {
      alert(
        "Salary Paid Amount must be greater than zero."
      );
      return;
    }

    if (
      paymentMode !== "Cash" &&
      paymentMode !== "Online"
    ) {
      alert(
        "Payment Mode must be either Cash or Online."
      );
      return;
    }

    onSave({
      ...payment,
      salaryPeriodFrom,
      salaryPeriodTo,
      paymentDate,
      amount: numericAmount,
      paymentMode,
      remarks:
        String(remarks || "").trim() ||
        "Imported historical salary payment",
    });
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 10040,
        background: "rgba(17, 24, 39, 0.68)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 18,
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        style={{
          width: "min(650px, 96vw)",
          background: "#ffffff",
          borderRadius: 14,
          boxShadow:
            "0 24px 60px rgba(0, 0, 0, 0.3)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: "18px 20px",
            borderBottom: "1px solid #e5e7eb",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: 14,
          }}
        >
          <div>
            <h3
              style={{
                margin: 0,
                color: "#111827",
              }}
            >
              Edit Salary Payment
            </h3>

            <div
              style={{
                marginTop: 6,
                fontSize: 13,
                color: "#6b7280",
              }}
            >
              {payment.employeeName || "Employee"} • ID:{" "}
              {payment.employeeId || "—"}
            </div>
          </div>

          <button
            type="button"
            className="btn"
            onClick={onClose}
            style={{
              minWidth: 38,
              padding: "7px 10px",
              border: "1px solid #d1d5db",
              background: "#ffffff",
              fontWeight: 900,
              fontSize: 17,
            }}
          >
            ×
          </button>
        </div>

        <div
          style={{
            padding: 20,
          }}
        >
          <div
            style={{
              marginBottom: 14,
              padding: 12,
              borderRadius: 10,
              background: "#f9fafb",
              border: "1px solid #e5e7eb",
              fontSize: 13,
              color: "#374151",
            }}
          >
            Current record: Salary Period{" "}
            <strong>
              {formatEditDate(
                payment.salaryPeriodFrom
              )}
            </strong>{" "}
            to{" "}
            <strong>
              {formatEditDate(payment.salaryPeriodTo)}
            </strong>
            , Payment Date{" "}
            <strong>
              {formatEditDate(payment.paymentDate)}
            </strong>
            , Amount{" "}
            <strong>
              ₹
              {Math.round(
                Number(payment.amount || 0)
              ).toLocaleString("en-IN")}
            </strong>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns:
                "repeat(auto-fit, minmax(220px, 1fr))",
              gap: 14,
            }}
          >
            <label
              style={{
                fontWeight: 800,
                fontSize: 13,
              }}
            >
              Salary Period From
              <input
                type="date"
                value={salaryPeriodFrom}
                onChange={(event) =>
                  setSalaryPeriodFrom(
                    event.target.value
                  )
                }
                style={{
                  width: "100%",
                  marginTop: 6,
                  padding: 10,
                  borderRadius: 8,
                  border: "1px solid #d1d5db",
                  fontWeight: 700,
                }}
              />
            </label>

            <label
              style={{
                fontWeight: 800,
                fontSize: 13,
              }}
            >
              Salary Period To
              <input
                type="date"
                value={salaryPeriodTo}
                onChange={(event) =>
                  setSalaryPeriodTo(
                    event.target.value
                  )
                }
                style={{
                  width: "100%",
                  marginTop: 6,
                  padding: 10,
                  borderRadius: 8,
                  border: "1px solid #d1d5db",
                  fontWeight: 700,
                }}
              />
            </label>

            <label
              style={{
                fontWeight: 800,
                fontSize: 13,
              }}
            >
              Payment Date
              <input
                type="date"
                value={paymentDate}
                onChange={(event) =>
                  setPaymentDate(event.target.value)
                }
                style={{
                  width: "100%",
                  marginTop: 6,
                  padding: 10,
                  borderRadius: 8,
                  border: "1px solid #d1d5db",
                  fontWeight: 700,
                }}
              />
            </label>

            <label
              style={{
                fontWeight: 800,
                fontSize: 13,
              }}
            >
              Salary Paid Amount
              <input
                type="number"
                value={amount}
                onChange={(event) =>
                  setAmount(event.target.value)
                }
                min="1"
                step="1"
                style={{
                  width: "100%",
                  marginTop: 6,
                  padding: 10,
                  borderRadius: 8,
                  border: "1px solid #d1d5db",
                  fontWeight: 700,
                }}
              />
            </label>

            <label
              style={{
                fontWeight: 800,
                fontSize: 13,
              }}
            >
              Payment Mode
              <select
                value={paymentMode}
                onChange={(event) =>
                  setPaymentMode(
                    event.target.value
                  )
                }
                style={{
                  width: "100%",
                  marginTop: 6,
                  padding: 10,
                  borderRadius: 8,
                  border: "1px solid #d1d5db",
                  fontWeight: 700,
                }}
              >
                <option value="Cash">Cash</option>
                <option value="Online">Online</option>
              </select>
            </label>

            <label
              style={{
                fontWeight: 800,
                fontSize: 13,
                gridColumn: "1 / -1",
              }}
            >
              Remarks
              <textarea
                value={remarks}
                onChange={(event) =>
                  setRemarks(event.target.value)
                }
                rows={3}
                style={{
                  width: "100%",
                  marginTop: 6,
                  padding: 10,
                  borderRadius: 8,
                  border: "1px solid #d1d5db",
                  fontWeight: 600,
                  resize: "vertical",
                }}
              />
            </label>
          </div>
        </div>

        <div
          style={{
            padding: "14px 20px",
            borderTop: "1px solid #e5e7eb",
            display: "flex",
            justifyContent: "flex-end",
            gap: 10,
            flexWrap: "wrap",
          }}
        >
          <button
            type="button"
            className="btn"
            onClick={onClose}
            style={{
              background: "#ffffff",
              color: "#111827",
              border: "1px solid #d1d5db",
              fontWeight: 800,
              minWidth: 100,
            }}
          >
            Cancel
          </button>

          <button
            type="button"
            className="btn"
            onClick={handleSave}
            style={{
              background: "#166534",
              color: "#ffffff",
              border: "none",
              fontWeight: 800,
              minWidth: 140,
            }}
          >
            Save Changes
          </button>
        </div>
      </div>
    </div>
  );
}

function HistoricalSalaryPaymentExpandDialog({
  batch,
  onClose,
  onEditPayment,
  onDeletePayment,
}) {
  const payments = Array.isArray(batch?.payments)
    ? batch.payments
    : [];

  const firstPayment = payments[0] || {};

  const paymentDate =
    batch?.paymentDate ||
    firstPayment.paymentDate ||
    "";

  const salaryPeriodFrom =
    firstPayment.salaryPeriodFrom || "";

  const salaryPeriodTo =
    firstPayment.salaryPeriodTo || "";

  const employeeType =
    batch?.employeeType ||
    firstPayment.employeeType ||
    "";

  const employeeTypeLabel =
    employeeType === "contractual"
      ? "Contractual"
      : "Non-contractual";

  const formatExpandDate = (dateValue) =>
    dateValue
      ? String(dateValue)
          .split("-")
          .reverse()
          .join("-")
      : "—";

  const totalPaid = payments.reduce(
    (total, payment) =>
      total + Number(payment.amount || 0),
    0
  );

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 10030,
        background: "rgba(17, 24, 39, 0.68)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 18,
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        style={{
          width: "min(980px, 96vw)",
          maxHeight: "90vh",
          background: "#ffffff",
          borderRadius: 14,
          boxShadow:
            "0 24px 60px rgba(0, 0, 0, 0.3)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: "18px 20px",
            borderBottom: "1px solid #e5e7eb",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: 14,
          }}
        >
          <div>
            <h3
              style={{
                margin: 0,
                color: "#111827",
              }}
            >
              Individual Salary Payments
            </h3>

            <div
              style={{
                marginTop: 6,
                fontSize: 13,
                color: "#6b7280",
              }}
            >
              {employeeTypeLabel} • Salary Period:{" "}
              {formatExpandDate(
                salaryPeriodFrom
              )}{" "}
              to{" "}
              {formatExpandDate(
                salaryPeriodTo
              )}{" "}
              • Payment Date:{" "}
              {formatExpandDate(paymentDate)}
            </div>
          </div>

          <button
            type="button"
            className="btn"
            onClick={onClose}
            style={{
              minWidth: 38,
              padding: "7px 10px",
              border: "1px solid #d1d5db",
              background: "#ffffff",
              fontWeight: 900,
              fontSize: 17,
            }}
            aria-label="Close individual payments"
          >
            ×
          </button>
        </div>

        <div
          style={{
            padding: 18,
            overflowY: "auto",
          }}
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns:
                "repeat(auto-fit, minmax(170px, 1fr))",
              gap: 10,
              marginBottom: 14,
            }}
          >
            <div
              style={{
                padding: 12,
                borderRadius: 9,
                background: "#f9fafb",
                border: "1px solid #e5e7eb",
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  color: "#6b7280",
                }}
              >
                Employees Paid
              </div>

              <div
                style={{
                  marginTop: 4,
                  fontSize: 20,
                  fontWeight: 900,
                }}
              >
                {payments.length}
              </div>
            </div>

            <div
              style={{
                padding: 12,
                borderRadius: 9,
                background: "#ecfdf5",
                border: "1px solid #a7f3d0",
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  color: "#047857",
                }}
              >
                Total Amount
              </div>

              <div
                style={{
                  marginTop: 4,
                  fontSize: 20,
                  fontWeight: 900,
                  color: "#047857",
                }}
              >
                ₹
                {Math.round(
                  totalPaid
                ).toLocaleString("en-IN")}
              </div>
            </div>
          </div>

          <div
            style={{
              border: "1px solid #e5e7eb",
              borderRadius: 10,
              overflow: "hidden",
            }}
          >
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
              }}
            >
              <thead>
                <tr
                  style={{
                    background: "#f3f4f6",
                  }}
                >
                  <th
                    style={{
                      padding: 10,
                      textAlign: "center",
                    }}
                  >
                    SL
                  </th>

                  <th
                    style={{
                      padding: 10,
                      textAlign: "left",
                    }}
                  >
                    Employee
                  </th>

                  <th
                    style={{
                      padding: 10,
                      textAlign: "left",
                    }}
                  >
                    Branch
                  </th>

                  <th
                    style={{
                      padding: 10,
                      textAlign: "center",
                    }}
                  >
                    Mode
                  </th>

                  <th
                    style={{
                      padding: 10,
                      textAlign: "right",
                    }}
                  >
                    Amount
                  </th>

                  <th
                    style={{
                      padding: 10,
                      textAlign: "center",
                    }}
                  >
                    Action
                  </th>
                </tr>
              </thead>

              <tbody>
                {payments.map(
                  (payment, paymentIndex) => (
                    <tr
                      key={`${batch?.id || "salary"}-${paymentIndex}`}
                      style={{
                        borderTop:
                          "1px solid #e5e7eb",
                      }}
                    >
                      <td
                        style={{
                          padding: 10,
                          textAlign: "center",
                          fontWeight: 700,
                        }}
                      >
                        {paymentIndex + 1}
                      </td>

                      <td
                        style={{
                          padding: 10,
                        }}
                      >
                        <div
                          style={{
                            fontWeight: 800,
                          }}
                        >
                          {payment.employeeName ||
                            "—"}
                        </div>

                        <div
                          style={{
                            marginTop: 3,
                            fontSize: 11,
                            color: "#6b7280",
                          }}
                        >
                          ID:{" "}
                          {payment.employeeId ||
                            "—"}
                        </div>
                      </td>

                      <td
                        style={{
                          padding: 10,
                          fontSize: 12,
                          color: "#374151",
                        }}
                      >
                        {payment.branch || "—"}
                      </td>

                      <td
                        style={{
                          padding: 10,
                          textAlign: "center",
                          fontWeight: 800,
                          color:
                            payment.paymentMode ===
                            "Online"
                              ? "#2563eb"
                              : "#166534",
                        }}
                      >
                        {payment.paymentMode ||
                          "Cash"}
                      </td>

                      <td
                        style={{
                          padding: 10,
                          textAlign: "right",
                          fontWeight: 900,
                          color: "#047857",
                        }}
                      >
                        ₹
                        {Math.round(
                          Number(
                            payment.amount || 0
                          )
                        ).toLocaleString(
                          "en-IN"
                        )}
                      </td>

                      <td
  style={{
    padding: 10,
    textAlign: "center",
  }}
>
  <div
    style={{
      display: "flex",
      justifyContent: "center",
      gap: 8,
      flexWrap: "wrap",
    }}
  >
    <button
      type="button"
      className="btn"
      onClick={() =>
        onEditPayment(
          batch.id,
          paymentIndex,
          payment
        )
      }
      style={{
        background: "#f59e0b",
        color: "#111827",
        border: "none",
        fontWeight: 800,
      }}
    >
      Edit
    </button>

    <button
      type="button"
      className="btn"
      onClick={() =>
        onDeletePayment(
          batch.id,
          paymentIndex,
          payment
        )
      }
      style={{
        background: "#dc2626",
        color: "#ffffff",
        border: "none",
        fontWeight: 700,
      }}
    >
      Delete
    </button>
  </div>
</td>
                    </tr>
                  )
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div
          style={{
            padding: "14px 20px",
            borderTop: "1px solid #e5e7eb",
            display: "flex",
            justifyContent: "flex-end",
          }}
        >
          <button
            type="button"
            className="btn"
            onClick={onClose}
            style={{
              background: "#111827",
              color: "#ffffff",
              border: "none",
              fontWeight: 800,
              minWidth: 100,
            }}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function HistoricalSalaryPaymentSummaryDialog({
  batch,
  onClose,
}) {
  const payments = Array.isArray(batch?.payments)
    ? batch.payments
    : [];

  const firstPayment = payments[0] || {};

  const paymentDate =
    batch?.paymentDate ||
    firstPayment.paymentDate ||
    "";

  const salaryPeriodFrom =
    firstPayment.salaryPeriodFrom || "";

  const salaryPeriodTo =
    firstPayment.salaryPeriodTo || "";

  const employeeType =
    batch?.employeeType ||
    firstPayment.employeeType ||
    "";

  const employeeTypeLabel =
    employeeType === "contractual"
      ? "Contractual"
      : "Non-contractual";

  const formatSummaryDate = (dateValue) =>
    dateValue
      ? String(dateValue)
          .split("-")
          .reverse()
          .join("-")
      : "—";

  const totalCash = payments
    .filter(
      (payment) =>
        payment.paymentMode !== "Online"
    )
    .reduce(
      (total, payment) =>
        total + Number(payment.amount || 0),
      0
    );

  const totalOnline = payments
    .filter(
      (payment) =>
        payment.paymentMode === "Online"
    )
    .reduce(
      (total, payment) =>
        total + Number(payment.amount || 0),
      0
    );

  const totalPaid =
  totalCash + totalOnline;

const downloadSalaryPaymentSummaryPdf = async () => {
  if (!payments.length) {
    alert(
      "No salary-payment records are available to download."
    );
    return;
  }

  const doc = new jsPDF({
    orientation: "landscape",
    unit: "pt",
    format: "a4",
  });

  try {
    await loadRupeeFont(doc);
  } catch (error) {
    console.error(
      "Salary PDF font could not be loaded:",
      error
    );
  }

  const pdfFont =
    doc.getFontList?.()?.NotoSans
      ? "NotoSans"
      : "helvetica";

  const pageWidth =
    doc.internal.pageSize.getWidth();

  doc.setFont(pdfFont, "bold");
  doc.setFontSize(17);

  doc.text(
    "HVF Agency — Historical Salary Payment Summary",
    pageWidth / 2,
    32,
    {
      align: "center",
    }
  );

  doc.setFont(pdfFont, "normal");
  doc.setFontSize(9);

  doc.text(
    `Employee Type: ${employeeTypeLabel}`,
    30,
    58
  );

  doc.text(
    `Salary Period: ${formatSummaryDate(
      salaryPeriodFrom
    )} to ${formatSummaryDate(
      salaryPeriodTo
    )}`,
    30,
    74
  );

  doc.text(
    `Payment Date: ${formatSummaryDate(
      paymentDate
    )}`,
    30,
    90
  );

  doc.text(
    `Employees Paid: ${payments.length}`,
    pageWidth - 30,
    58,
    {
      align: "right",
    }
  );

  doc.text(
    `Total Cash: ₹${Math.round(
      totalCash
    ).toLocaleString("en-IN")}`,
    pageWidth - 30,
    74,
    {
      align: "right",
    }
  );

  doc.text(
    `Total Online: ₹${Math.round(
      totalOnline
    ).toLocaleString("en-IN")}`,
    pageWidth - 30,
    90,
    {
      align: "right",
    }
  );

  const tableBody = payments.map(
    (payment, index) => [
      index + 1,
      payment.employeeName || "—",
      payment.employeeId || "—",
      payment.branch || "—",
      payment.paymentMode || "Cash",
      `₹${Math.round(
        Number(payment.amount || 0)
      ).toLocaleString("en-IN")}`,
      payment.remarks || "—",
    ]
  );

  autoTable(doc, {
    startY: 108,
    head: [
      [
        "SL",
        "Employee",
        "Employee ID",
        "Branch",
        "Mode",
        "Amount",
        "Remarks",
      ],
    ],
    body: tableBody,
    theme: "grid",
    margin: {
      left: 24,
      right: 24,
    },
    styles: {
      font: pdfFont,
      fontSize: 8,
      cellPadding: 5,
      lineColor: [209, 213, 219],
      lineWidth: 0.4,
      textColor: [17, 24, 39],
      valign: "middle",
    },
    headStyles: {
      font: pdfFont,
      fontStyle: "bold",
      fillColor: [220, 252, 231],
      textColor: [22, 101, 52],
      halign: "center",
    },
    columnStyles: {
      0: {
        cellWidth: 28,
        halign: "center",
      },
      1: {
        cellWidth: 120,
        fontStyle: "bold",
      },
      2: {
        cellWidth: 65,
        halign: "center",
      },
      3: {
        cellWidth: 120,
      },
      4: {
        cellWidth: 60,
        halign: "center",
      },
      5: {
        cellWidth: 80,
        halign: "right",
        fontStyle: "bold",
      },
    },
    foot: [
      [
        "",
        "",
        "",
        "",
        "Total Salary Paid",
        `₹${Math.round(
          totalPaid
        ).toLocaleString("en-IN")}`,
        "",
      ],
    ],
    footStyles: {
      font: pdfFont,
      fontStyle: "bold",
      fillColor: [236, 253, 245],
      textColor: [4, 120, 87],
    },
  });

  doc.save(
    `Historical_Salary_Payment_${employeeTypeLabel.replace(
      /\s+/g,
      "_"
    )}_${salaryPeriodFrom}_to_${salaryPeriodTo}.pdf`
  );
};

return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 10020,
        background: "rgba(17, 24, 39, 0.68)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 18,
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        style={{
          width: "min(1050px, 96vw)",
          maxHeight: "90vh",
          overflow: "hidden",
          background: "#ffffff",
          borderRadius: 14,
          boxShadow:
            "0 24px 60px rgba(0, 0, 0, 0.3)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          style={{
            padding: "18px 20px",
            borderBottom: "1px solid #e5e7eb",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: 14,
          }}
        >
          <div>
            <h3
              style={{
                margin: 0,
                color: "#111827",
              }}
            >
              Historical Salary Payment Summary
            </h3>

            <div
              style={{
                marginTop: 6,
                fontSize: 13,
                color: "#6b7280",
              }}
            >
              Consolidated salary-payment details
              for this saved cycle.
            </div>
          </div>

          <button
            type="button"
            className="btn"
            onClick={onClose}
            style={{
              minWidth: 38,
              padding: "7px 10px",
              border: "1px solid #d1d5db",
              background: "#ffffff",
              fontWeight: 900,
              fontSize: 17,
            }}
            aria-label="Close summary"
          >
            ×
          </button>
        </div>

        <div
          style={{
            padding: 20,
            overflowY: "auto",
          }}
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns:
                "repeat(auto-fit, minmax(180px, 1fr))",
              gap: 10,
            }}
          >
            <div
              style={{
                padding: 12,
                borderRadius: 9,
                background: "#f9fafb",
                border: "1px solid #e5e7eb",
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  color: "#6b7280",
                }}
              >
                Employee Type
              </div>

              <div
                style={{
                  marginTop: 4,
                  fontWeight: 900,
                }}
              >
                {employeeTypeLabel}
              </div>
            </div>

            <div
              style={{
                padding: 12,
                borderRadius: 9,
                background: "#f9fafb",
                border: "1px solid #e5e7eb",
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  color: "#6b7280",
                }}
              >
                Salary Period
              </div>

              <div
                style={{
                  marginTop: 4,
                  fontWeight: 900,
                }}
              >
                {formatSummaryDate(
                  salaryPeriodFrom
                )}{" "}
                to{" "}
                {formatSummaryDate(
                  salaryPeriodTo
                )}
              </div>
            </div>

            <div
              style={{
                padding: 12,
                borderRadius: 9,
                background: "#f9fafb",
                border: "1px solid #e5e7eb",
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  color: "#6b7280",
                }}
              >
                Payment Date
              </div>

              <div
                style={{
                  marginTop: 4,
                  fontWeight: 900,
                }}
              >
                {formatSummaryDate(
                  paymentDate
                )}
              </div>
            </div>

            <div
              style={{
                padding: 12,
                borderRadius: 9,
                background: "#f9fafb",
                border: "1px solid #e5e7eb",
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  color: "#6b7280",
                }}
              >
                Employees Paid
              </div>

              <div
                style={{
                  marginTop: 4,
                  fontWeight: 900,
                  fontSize: 20,
                }}
              >
                {payments.length}
              </div>
            </div>
          </div>

          <div
            style={{
              marginTop: 12,
              display: "grid",
              gridTemplateColumns:
                "repeat(auto-fit, minmax(180px, 1fr))",
              gap: 10,
            }}
          >
            <div
              style={{
                padding: 12,
                borderRadius: 9,
                background: "#f0fdf4",
                border: "1px solid #bbf7d0",
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  color: "#166534",
                }}
              >
                Total Cash
              </div>

              <div
                style={{
                  marginTop: 4,
                  fontWeight: 900,
                  fontSize: 20,
                  color: "#166534",
                }}
              >
                ₹
                {Math.round(
                  totalCash
                ).toLocaleString("en-IN")}
              </div>
            </div>

            <div
              style={{
                padding: 12,
                borderRadius: 9,
                background: "#eff6ff",
                border: "1px solid #bfdbfe",
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  color: "#2563eb",
                }}
              >
                Total Online
              </div>

              <div
                style={{
                  marginTop: 4,
                  fontWeight: 900,
                  fontSize: 20,
                  color: "#2563eb",
                }}
              >
                ₹
                {Math.round(
                  totalOnline
                ).toLocaleString("en-IN")}
              </div>
            </div>

            <div
              style={{
                padding: 12,
                borderRadius: 9,
                background: "#ecfdf5",
                border: "1px solid #a7f3d0",
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  color: "#047857",
                }}
              >
                Total Salary Paid
              </div>

              <div
                style={{
                  marginTop: 4,
                  fontWeight: 900,
                  fontSize: 20,
                  color: "#047857",
                }}
              >
                ₹
                {Math.round(
                  totalPaid
                ).toLocaleString("en-IN")}
              </div>
            </div>
          </div>

          <div
            style={{
              marginTop: 18,
              overflowX: "auto",
              border: "1px solid #e5e7eb",
              borderRadius: 10,
            }}
          >
            <table
              style={{
                width: "100%",
                minWidth: 850,
                borderCollapse: "collapse",
              }}
            >
              <thead>
                <tr
                  style={{
                    background: "#f3f4f6",
                  }}
                >
                  <th
                    style={{
                      padding: 10,
                      textAlign: "center",
                    }}
                  >
                    SL
                  </th>

                  <th
                    style={{
                      padding: 10,
                      textAlign: "left",
                    }}
                  >
                    Employee
                  </th>

                  <th
                    style={{
                      padding: 10,
                      textAlign: "left",
                    }}
                  >
                    Branch
                  </th>

                  <th
                    style={{
                      padding: 10,
                      textAlign: "center",
                    }}
                  >
                    Mode
                  </th>

                  <th
                    style={{
                      padding: 10,
                      textAlign: "right",
                    }}
                  >
                    Amount
                  </th>

                  <th
                    style={{
                      padding: 10,
                      textAlign: "left",
                    }}
                  >
                    Remarks
                  </th>
                </tr>
              </thead>

              <tbody>
                {payments.map(
                  (payment, index) => (
                    <tr
                      key={`${batch?.id || "salary"}-${index}`}
                      style={{
                        borderTop:
                          "1px solid #e5e7eb",
                      }}
                    >
                      <td
                        style={{
                          padding: 10,
                          textAlign: "center",
                          fontWeight: 700,
                        }}
                      >
                        {index + 1}
                      </td>

                      <td
                        style={{
                          padding: 10,
                        }}
                      >
                        <div
                          style={{
                            fontWeight: 800,
                          }}
                        >
                          {payment.employeeName ||
                            "—"}
                        </div>

                        <div
                          style={{
                            marginTop: 3,
                            fontSize: 11,
                            color: "#6b7280",
                          }}
                        >
                          ID:{" "}
                          {payment.employeeId ||
                            "—"}
                        </div>
                      </td>

                      <td
                        style={{
                          padding: 10,
                        }}
                      >
                        {payment.branch || "—"}
                      </td>

                      <td
                        style={{
                          padding: 10,
                          textAlign: "center",
                          fontWeight: 800,
                          color:
                            payment.paymentMode ===
                            "Online"
                              ? "#2563eb"
                              : "#166534",
                        }}
                      >
                        {payment.paymentMode ||
                          "Cash"}
                      </td>

                      <td
                        style={{
                          padding: 10,
                          textAlign: "right",
                          fontWeight: 900,
                          color: "#047857",
                        }}
                      >
                        ₹
                        {Math.round(
                          Number(
                            payment.amount || 0
                          )
                        ).toLocaleString(
                          "en-IN"
                        )}
                      </td>

                      <td
                        style={{
                          padding: 10,
                          fontSize: 12,
                          color: "#6b7280",
                        }}
                      >
                        {payment.remarks || "—"}
                      </td>
                    </tr>
                  )
                )}
              </tbody>

              <tfoot>
                <tr
                  style={{
                    borderTop:
                      "2px solid #9ca3af",
                    background: "#f9fafb",
                  }}
                >
                  <td
                    colSpan={4}
                    style={{
                      padding: 11,
                      textAlign: "right",
                      fontWeight: 900,
                    }}
                  >
                    Total Salary Paid
                  </td>

                  <td
                    style={{
                      padding: 11,
                      textAlign: "right",
                      fontWeight: 900,
                      color: "#047857",
                      fontSize: 16,
                    }}
                  >
                    ₹
                    {Math.round(
                      totalPaid
                    ).toLocaleString(
                      "en-IN"
                    )}
                  </td>

                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        </div>

        <div
          style={{
            padding: "14px 20px",
            borderTop: "1px solid #e5e7eb",
            display: "flex",
            justifyContent: "flex-end",
          }}
        >
          <div
  style={{
    display: "flex",
    justifyContent: "flex-end",
    gap: 10,
    flexWrap: "wrap",
  }}
>
  <button
    type="button"
    className="btn"
    onClick={downloadSalaryPaymentSummaryPdf}
    style={{
      background: "#166534",
      color: "#ffffff",
      border: "none",
      fontWeight: 800,
      minWidth: 130,
    }}
  >
    Download PDF
  </button>

  <button
    type="button"
    className="btn"
    onClick={onClose}
    style={{
      background: "#111827",
      color: "#ffffff",
      border: "none",
      fontWeight: 800,
      minWidth: 100,
    }}
  >
    Close
  </button>
</div>
        </div>
      </div>
    </div>
  );
}

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
const [page, setPage] = useState(() => __boot.page || "catalog"); // "catalog" | "quoteEditor" | "savedDetailed" | "payroll"

const [payrollTab, setPayrollTab] = useState("contractual"); // contractual | non_contractual
const [payrollShowAll, setPayrollShowAll] = useState(false);
const [payrollEmployees, setPayrollEmployees] = useState(() => {
  try {
    return JSON.parse(localStorage.getItem("hvf.payrollEmployees") || "[]");
  } catch {
    return [];
  }
});
const [showEmployeeForm, setShowEmployeeForm] = useState(false);
const [selectedPayrollEmployee, setSelectedPayrollEmployee] = useState(null);
const [editingPayrollEmployeeId, setEditingPayrollEmployeeId] = useState(null);
const [payrollMonth, setPayrollMonth] = useState("");
const [createdPayrollWorksheet, setCreatedPayrollWorksheet] = useState(null);
const [openedPayrollWorksheetId, setOpenedPayrollWorksheetId] = useState(null);
const [payrollWorksheetEntries, setPayrollWorksheetEntries] = useState({});
const [attendanceTab, setAttendanceTab] = useState("contractual");

// Advance Payment
const [advanceTab, setAdvanceTab] = useState("non_contractual");
const [advanceEmployeeSearch, setAdvanceEmployeeSearch] = useState("");
const [advanceHistorySearch, setAdvanceHistorySearch] = useState("");
const [advanceDate, setAdvanceDate] = useState(() => {
  const savedAdvanceDate = localStorage.getItem("hvf.advanceDate");

  if (savedAdvanceDate) {
    return savedAdvanceDate;
  }

  const today = new Date();
  today.setMinutes(today.getMinutes() - today.getTimezoneOffset());
  return today.toISOString().slice(0, 10);
});

const [selectedAdvanceEmployeeIds, setSelectedAdvanceEmployeeIds] = useState(
  []
);
const [showAdvanceGenerator, setShowAdvanceGenerator] = useState(false);
const [advanceDraftEntries, setAdvanceDraftEntries] = useState({});

const [savedAdvanceBatches, setSavedAdvanceBatches] = useState(() => {
  try {
    return JSON.parse(
      localStorage.getItem("hvf.savedAdvanceBatches") || "[]"
    );
  } catch {
    return [];
  }
});

// Starting Payable Balance
const [startingBalanceType, setStartingBalanceType] = useState(() => {
  return (
    localStorage.getItem("hvf.startingBalanceType") ||
    "non_contractual"
  );
});

const [startingBalanceDate, setStartingBalanceDate] = useState(() => {
  return localStorage.getItem("hvf.startingBalanceDate") || "";
});

const [
  startingBalanceCoveredTillDate,
  setStartingBalanceCoveredTillDate,
] = useState(() => {
  return (
    localStorage.getItem("hvf.startingBalanceCoveredTillDate") || ""
  );
});

const [
  startingBalanceDraftEntries,
  setStartingBalanceDraftEntries,
] = useState(() => {
  try {
    return JSON.parse(
      localStorage.getItem("hvf.startingBalanceDraftEntries") || "{}"
    );
  } catch {
    return {};
  }
});

const [
  savedStartingPayableBalances,
  setSavedStartingPayableBalances,
] = useState(() => {
  try {
    return JSON.parse(
      localStorage.getItem("hvf.savedStartingPayableBalances") || "[]"
    );
  } catch {
    return [];
  }
});

const [
  generatedStartingPayableSummary,
  setGeneratedStartingPayableSummary,
] = useState(null);

const [generatedAdvanceSummary, setGeneratedAdvanceSummary] =
  useState(null);

// Historical Advance Import
const [historicalAdvanceFromDate, setHistoricalAdvanceFromDate] =
  useState("");

const [historicalAdvanceToDate, setHistoricalAdvanceToDate] =
  useState("");

const [
  historicalAdvanceEmployeeType,
  setHistoricalAdvanceEmployeeType,
] = useState("non_contractual");

const [
  parsedHistoricalAdvances,
  setParsedHistoricalAdvances,
] = useState([]);

const [
  parsedHistoricalAdvanceSummary,
  setParsedHistoricalAdvanceSummary,
] = useState(null);

const [
  showHistoricalAdvanceConfirmDialog,
  setShowHistoricalAdvanceConfirmDialog,
] = useState(false);

const historicalAdvanceImportInputRef = useRef(null);

// Historical Salary Payment Import
const [
  historicalSalaryPaymentFromDate,
  setHistoricalSalaryPaymentFromDate,
] = useState("");

const [
  historicalSalaryPaymentToDate,
  setHistoricalSalaryPaymentToDate,
] = useState("");

const [
  historicalSalaryPaymentEmployeeType,
  setHistoricalSalaryPaymentEmployeeType,
] = useState("non_contractual");

const [
  parsedHistoricalSalaryPayments,
  setParsedHistoricalSalaryPayments,
] = useState([]);

const [
  parsedHistoricalSalaryPaymentSummary,
  setParsedHistoricalSalaryPaymentSummary,
] = useState(null);

const [
  showHistoricalSalaryPaymentConfirmDialog,
  setShowHistoricalSalaryPaymentConfirmDialog,
] = useState(false);

const historicalSalaryPaymentImportInputRef = useRef(null);

// Saved Salary Payment History summary
const [
  selectedHistoricalSalaryPaymentBatch,
  setSelectedHistoricalSalaryPaymentBatch,
] = useState(null);

const [
  showHistoricalSalaryPaymentSummaryDialog,
  setShowHistoricalSalaryPaymentSummaryDialog,
] = useState(false);

// Saved Salary Payment History expanded-details dialog
const [
  selectedExpandedHistoricalSalaryPaymentBatch,
  setSelectedExpandedHistoricalSalaryPaymentBatch,
] = useState(null);

const [
  showHistoricalSalaryPaymentExpandDialog,
  setShowHistoricalSalaryPaymentExpandDialog,
] = useState(false);

// Saved Salary Payment History edit dialog
const [
  selectedEditHistoricalSalaryPayment,
  setSelectedEditHistoricalSalaryPayment,
] = useState(null);

const [
  showHistoricalSalaryPaymentEditDialog,
  setShowHistoricalSalaryPaymentEditDialog,
] = useState(false);

const [
  savedHistoricalSalaryPaymentBatches,
  setSavedHistoricalSalaryPaymentBatches,
] = useState(() => {
  try {
    return JSON.parse(
      localStorage.getItem(
        "hvf.savedHistoricalSalaryPaymentBatches"
      ) || "[]"
    );
  } catch {
    return [];
  }
});

useEffect(() => {
  localStorage.setItem(
    "hvf.savedHistoricalSalaryPaymentBatches",
    JSON.stringify(savedHistoricalSalaryPaymentBatches)
  );
}, [savedHistoricalSalaryPaymentBatches]);

const downloadPayrollLocalStorageBackup = () => {
  const backupData = {
    app: "HVF Payroll",
    backupType: "localStorage",
    createdAt: new Date().toISOString(),
    keys: {},
  };

  Object.keys(localStorage)
    .filter((key) => key.startsWith("hvf."))
    .sort()
    .forEach((key) => {
      backupData.keys[key] = localStorage.getItem(key);
    });

  const backupBlob = new Blob(
    [JSON.stringify(backupData, null, 2)],
    {
      type: "application/json",
    }
  );

  const backupUrl = URL.createObjectURL(backupBlob);

  const backupLink = document.createElement("a");

  const today = new Date()
    .toISOString()
    .slice(0, 10);

  backupLink.href = backupUrl;
  backupLink.download = `HVF_Payroll_Backup_${today}.json`;
  backupLink.click();

  URL.revokeObjectURL(backupUrl);
};

const restorePayrollLocalStorageBackup = () => {
  const confirmed = window.confirm(
    "Restore payroll data from a backup file?\n\nThis will replace the current saved payroll data in this browser. Please make sure you have downloaded a fresh backup before restoring."
  );

  if (!confirmed) {
    return;
  }

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "application/json";

  fileInput.onchange = (event) => {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    const reader = new FileReader();

    reader.onload = (loadEvent) => {
      try {
        const parsedBackup = JSON.parse(
          String(loadEvent.target.result || "")
        );

        if (
          parsedBackup.app !== "HVF Payroll" ||
          parsedBackup.backupType !== "localStorage" ||
          !parsedBackup.keys ||
          typeof parsedBackup.keys !== "object"
        ) {
          alert(
            "Invalid backup file. Please select a valid HVF Payroll backup JSON file."
          );
          return;
        }

        Object.keys(localStorage)
          .filter((key) => key.startsWith("hvf."))
          .forEach((key) => {
            localStorage.removeItem(key);
          });

        Object.entries(parsedBackup.keys).forEach(
          ([key, value]) => {
            if (key.startsWith("hvf.")) {
              localStorage.setItem(key, String(value ?? ""));
            }
          }
        );

        alert(
          "Payroll backup restored successfully. The app will now reload."
        );

        window.location.reload();
      } catch (error) {
        console.error(
          "Payroll backup restore failed:",
          error
        );

        alert(
          "Could not restore backup. Please check that the selected file is a valid JSON backup."
        );
      }
    };

    reader.onerror = () => {
      alert(
        "Could not read the selected backup file."
      );
    };

    reader.readAsText(file);
  };

  fileInput.click();
};



const matchesAdvanceEmployeeSearch = (emp) => {
  const searchText = advanceEmployeeSearch.trim().toLowerCase();

  if (!searchText) return true;

  return [
    emp.name,
    emp.branch,
    emp.type === "contractual" ? "contractual" : "non contractual",
  ]
    .filter(Boolean)
    .some((value) =>
      String(value).toLowerCase().includes(searchText)
    );
};

const getFilteredAdvanceBatches = () => {
  const searchText = advanceHistorySearch.trim().toLowerCase();

  if (!searchText) return savedAdvanceBatches;

  return savedAdvanceBatches.filter((batch) => {
    const displayDate = batch.advanceDate
  ? batch.advanceDate.split("-").reverse().join("-")
  : "";

const savedAtText = batch.createdAt
  ? (() => {
      const savedDate = new Date(batch.createdAt);

      const day = String(savedDate.getDate()).padStart(2, "0");
      const month = String(savedDate.getMonth() + 1).padStart(2, "0");
      const year = savedDate.getFullYear();

      const hours = String(savedDate.getHours()).padStart(2, "0");
      const minutes = String(savedDate.getMinutes()).padStart(2, "0");

      return `${day}-${month}-${year} ${hours}:${minutes}`;
    })()
  : "";

const employeeNames = (batch.employees || [])
      .map((entry) => entry.employeeName)
      .join(" ");

    const paymentModes = (batch.employees || [])
  .map((entry) => entry.paymentMode)
  .join(" ");

const remarksText = (batch.employees || [])
  .map((entry) => entry.remarks)
  .join(" ");

return [
  batch.id,
  batch.advanceDate,
  displayDate,
  savedAtText,
  employeeNames,
  paymentModes,
  remarksText,
  "cash",
  "online",
]
      .filter(Boolean)
      .some((value) =>
        String(value).toLowerCase().includes(searchText)
      );
  });
};

useEffect(() => {
  localStorage.setItem(
    "hvf.savedAdvanceBatches",
    JSON.stringify(savedAdvanceBatches)
  );
}, [savedAdvanceBatches]);

useEffect(() => {
  if (advanceDate) {
    localStorage.setItem("hvf.advanceDate", advanceDate);
  }
}, [advanceDate]);

useEffect(() => {
  localStorage.setItem(
    "hvf.savedStartingPayableBalances",
    JSON.stringify(savedStartingPayableBalances)
  );
}, [savedStartingPayableBalances]);

useEffect(() => {
  localStorage.setItem("hvf.startingBalanceType", startingBalanceType);
}, [startingBalanceType]);

useEffect(() => {
  if (startingBalanceDate) {
    localStorage.setItem(
      "hvf.startingBalanceDate",
      startingBalanceDate
    );
  }
}, [startingBalanceDate]);

useEffect(() => {
  if (startingBalanceCoveredTillDate) {
    localStorage.setItem(
      "hvf.startingBalanceCoveredTillDate",
      startingBalanceCoveredTillDate
    );
  }
}, [startingBalanceCoveredTillDate]);

useEffect(() => {
  localStorage.setItem(
    "hvf.startingBalanceDraftEntries",
    JSON.stringify(startingBalanceDraftEntries)
  );
}, [startingBalanceDraftEntries]);

const attendanceImportInputRef = useRef(null);

const employeeFormRef = useRef(null);
const [showAttendanceImport, setShowAttendanceImport] = useState(false);
const [attendanceImportFromDate, setAttendanceImportFromDate] = useState("");
const [attendanceImportToDate, setAttendanceImportToDate] = useState("");

const [attendanceImportPreviewRows, setAttendanceImportPreviewRows] = useState([]);
const [attendanceImportPendingEntries, setAttendanceImportPendingEntries] = useState({});

const [attendanceRegisterMode, setAttendanceRegisterMode] = useState(
  () => localStorage.getItem("hvf.attendanceRegisterMode") || "cycle"
);

const [attendanceRegisterFromDate, setAttendanceRegisterFromDate] = useState(
  () => localStorage.getItem("hvf.attendanceRegisterFromDate") || ""
);

const [attendanceRegisterToDate, setAttendanceRegisterToDate] = useState(
  () => localStorage.getItem("hvf.attendanceRegisterToDate") || ""
);

const [attendanceDate, setAttendanceDate] = useState(() => {
  return new Date().toISOString().slice(0, 10);
});

const [attendanceEntries, setAttendanceEntries] = useState(() => {
  try {
    return JSON.parse(localStorage.getItem("hvf.attendanceEntries") || "{}");
  } catch {
    return {};
  }
});
const [savedPayrollWorksheets, setSavedPayrollWorksheets] = useState(() => {
  try {
    return JSON.parse(localStorage.getItem("hvf.savedPayrollWorksheets") || "[]");
  } catch {
    return [];
  }
});
const [employeeForm, setEmployeeForm] = useState({
  type: "contractual",
  name: "",
  dob: "",
  address: "",
  joining_date: "",
  base_salary: "",
  phone: "",
  designation: "",
  branch: "",
});

const employeeImportInputRef = useRef(null);
const [showEmployeeImport, setShowEmployeeImport] = useState(false);
const [employeeImportRows, setEmployeeImportRows] = useState([]);

const [attendanceHistory, setAttendanceHistory] = useState(() => {
  try {
    return JSON.parse(localStorage.getItem("hvf.attendanceHistory") || "[]");
  } catch {
    return [];
  }
});

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

const [editingProductId, setEditingProductId] = useState(null);
const [editingImageUrl, setEditingImageUrl] = useState("");

const [editForm, setEditForm] = useState({
  name: "",
  category: "",
  mrp: "",
  sell_price: "",
  cost_price: "",
  specs: "",
  imageFile: null,
});

const [saving, setSaving] = useState(false);

const [catalogExportMode, setCatalogExportMode] = useState("PRICE"); // PRICE or DISPLAY
const [catalogExportCategories, setCatalogExportCategories] = useState(["ALL"]);
const [catalogIncludeSelling, setCatalogIncludeSelling] = useState(true);
const [catalogIncludeCost, setCatalogIncludeCost] = useState(false);
const [showCatalogExportPanel, setShowCatalogExportPanel] = useState(false);

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

    try {
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                "Supabase request timed out. Please check internet or Supabase connection."
              )
            ),
          12000
        )
      );

      const queryPromise = supabase
        .from("machines")
        .select("*")
        .order("created_at", { ascending: false });

      const { data, error } = await Promise.race([
        queryPromise,
        timeoutPromise,
      ]);

      if (error) {
        setMsg("Supabase error: " + error.message);
        setItems([]);
      } else {
        setItems(data || []);
      }
    } catch (error) {
      console.error("Catalog loading failed:", error);
      setMsg(error.message || "Catalog loading failed.");
      setItems([]);
    } finally {
      setLoading(false);
    }
  };

  const loadCategories = async () => {
    try {
      const { data, error } = await supabase
        .from("categories")
        .select("name")
        .order("name");

      if (error) {
        console.error("Category loading failed:", error);
        return;
      }

      setCategories((data || []).map((r) => r.name));
    } catch (error) {
      console.error("Category loading failed:", error);
    }
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

  const { data: s } = await supabase.auth.getSession();
  if (!s?.session?.user?.id) {
    alert("Please use 'Sign in (email link)' first, then try again.");
    return;
  }

  if (!form.name || !form.category || !form.mrp) {
    return alert("Name, Category and MRP are required.");
  }

  if (!editingProductId && !form.imageFile) {
    return alert("Image is required for new product.");
  }

  setSaving(true);

  try {
    let image_url = editingImageUrl || "";

    if (form.imageFile) {
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

      image_url = urlData.publicUrl;
    }

    const payload = {
      name: form.name,
      category: form.category,
      mrp: Number(form.mrp),
      sell_price: form.sell_price ? Number(form.sell_price) : null,
      cost_price: form.cost_price ? Number(form.cost_price) : null,
      specs: form.specs || "",
      image_url,
    };

    if (editingProductId) {
      const { error: updErr } = await supabase
        .from("machines")
        .update(payload)
        .eq("id", editingProductId);

      if (updErr) throw new Error("UPDATE: " + updErr.message);
    } else {
      const { error: insErr } = await supabase
        .from("machines")
        .insert(payload);

      if (insErr) throw new Error("INSERT: " + insErr.message);
    }

    setForm({
      name: "",
      category: "",
      mrp: "",
      sell_price: "",
      cost_price: "",
      specs: "",
      imageFile: null,
    });

    setEditingProductId(null);
    setEditingImageUrl("");

    await loadMachines();

    alert(editingProductId ? "Product updated ✅" : "Product added ✅");
  } catch (err) {
    console.error(err);
    alert(err.message);
  } finally {
    setSaving(false);
  }
};

const onEditSave = async (e) => {
  e.preventDefault();
  if (!isAdmin) return alert("Admins only.");
  if (!editingProductId) return alert("No product selected for editing.");

  if (!editForm.name || !editForm.category || !editForm.mrp) {
    return alert("Name, Category and MRP are required.");
  }

  setSaving(true);

  try {
    let image_url = editingImageUrl || "";

    if (editForm.imageFile) {
      const ext = editForm.imageFile.name.split(".").pop().toLowerCase();
      const safeBase = editForm.name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .slice(0, 40);

      const filePath = `products/${Date.now()}-${safeBase}.${ext}`;

      const { error: upErr } = await supabase.storage
        .from("images")
        .upload(filePath, editForm.imageFile, {
          cacheControl: "3600",
          contentType: editForm.imageFile.type || "image/jpeg",
        });

      if (upErr) throw new Error("UPLOAD: " + upErr.message);

      const { data: urlData } = supabase.storage
        .from("images")
        .getPublicUrl(filePath);

      image_url = urlData.publicUrl;
    }

    const payload = {
      name: editForm.name,
      category: editForm.category,
      mrp: Number(editForm.mrp),
      sell_price: editForm.sell_price ? Number(editForm.sell_price) : null,
      cost_price: editForm.cost_price ? Number(editForm.cost_price) : null,
      specs: editForm.specs || "",
      image_url,
    };

    const { error: updErr } = await supabase
      .from("machines")
      .update(payload)
      .eq("id", editingProductId);

    if (updErr) throw new Error("UPDATE: " + updErr.message);

    setEditingProductId(null);
    setEditingImageUrl("");
    setEditForm({
      name: "",
      category: "",
      mrp: "",
      sell_price: "",
      cost_price: "",
      specs: "",
      imageFile: null,
    });

    await loadMachines();

    alert("Product updated ✅");
  } catch (err) {
    console.error(err);
    alert(err.message);
  } finally {
    setSaving(false);
  }
};

const onDeleteProduct = async () => {
  if (!isAdmin) return alert("Admins only.");
  if (!editingProductId) return alert("No product selected for deletion.");

  const ok = window.confirm(
    "Are you sure you want to delete this product? This cannot be undone."
  );

  if (!ok) return;

  setSaving(true);

  try {
    const { error: delErr } = await supabase
      .from("machines")
      .delete()
      .eq("id", editingProductId);

    if (delErr) throw new Error("DELETE: " + delErr.message);

    setEditingProductId(null);
    setEditingImageUrl("");
    setEditForm({
      name: "",
      category: "",
      mrp: "",
      sell_price: "",
      cost_price: "",
      specs: "",
      imageFile: null,
    });

    await loadMachines();

    alert("Product deleted ✅");
  } catch (err) {
    console.error(err);
    alert(err.message);
  } finally {
    setSaving(false);
  }
};

const exportCatalogPdf = async () => {
 if (catalogExportMode === "DISPLAY") {
  const doc = new jsPDF({ unit: "pt", format: "a4", orientation: "portrait" });

  const selectedCategory = catalogExportCategories[0];

  const exportItems =
    selectedCategory === "ALL"
      ? items
      : items.filter((m) => m.category === selectedCategory);

  if (!exportItems.length) {
    alert("No products found.");
    return;
  }

  const loadImage = async (url) => {
    try {
      if (!url) return null;
      const res = await fetch(url);
      const blob = await res.blob();

      return await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      });
    } catch {
      return null;
    }
  };

  const drawImage = (img, x, y, boxW, boxH) => {
    try {
      const props = doc.getImageProperties(img);
      const ratio = props.width / props.height;

      let w = boxW;
      let h = w / ratio;

      if (h > boxH) {
        h = boxH;
        w = h * ratio;
      }

      doc.addImage(img, "JPEG", x + (boxW - w) / 2, y + (boxH - h) / 2, w, h);
    } catch {}
  };

  // Background
  doc.setFillColor(245, 248, 245);
  doc.rect(0, 0, 595, 842, "F");

  // Header
  doc.setFont("helvetica", "bold");
  doc.setFontSize(24);
  doc.setTextColor(26, 80, 45);
  doc.text("HVF AGENCY", 297.5, 50, { align: "center" });

  doc.setFontSize(13);
  doc.setTextColor(40, 40, 40);
  doc.text("PRODUCT CATALOG", 297.5, 70, { align: "center" });

  doc.setFontSize(9);
  doc.setTextColor(120, 120, 120);
  doc.text(
    selectedCategory === "ALL" ? "All Categories" : selectedCategory,
    297.5,
    85,
    { align: "center" }
  );

  let x = 40;
  let y = 110;

  const cardW = 240;
  const cardH = 280;
  const gapX = 30;
  const gapY = 30;

  for (let i = 0; i < exportItems.length; i++) {
    const m = exportItems[i];

    if (y + cardH > 800) {
      doc.addPage();

      doc.setFillColor(245, 248, 245);
      doc.rect(0, 0, 595, 842, "F");

      x = 40;
      y = 50;
    }

    // Card background
    // Soft shadow
doc.setFillColor(230, 235, 230);
doc.roundedRect(x + 3, y + 4, cardW, cardH, 12, 12, "F");

// Main card
doc.setFillColor(255, 255, 255);
doc.roundedRect(x, y, cardW, cardH, 12, 12, "F");

// Border
doc.setDrawColor(210, 215, 210);
doc.roundedRect(x, y, cardW, cardH, 12, 12, "S");

    // Image box
    // Premium image background
doc.setFillColor(252, 252, 252);
doc.roundedRect(x + 12, y + 12, cardW - 24, 140, 8, 8, "F");

// subtle inner border
doc.setDrawColor(235, 235, 235);
doc.roundedRect(x + 12, y + 12, cardW - 24, 140, 8, 8, "S");

    if (m.image_url) {
      const img = await loadImage(m.image_url);
      if (img) drawImage(img, x + 12, y + 12, cardW - 24, 140);
    }

    // Name
    doc.setFont("helvetica", "bold");
doc.setFontSize(12);
doc.setTextColor(30, 30, 30);
    doc.text(
      doc.splitTextToSize(m.name || "", cardW - 20),
      x + 10,
      y + 175
    );

    // Specs
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
doc.setTextColor(110, 110, 110);
    doc.text(
      doc.splitTextToSize(m.specs || "", cardW - 20),
      x + 10,
      y + 200
    );

    // Price badge
    if (catalogIncludeSelling) {
      doc.setFillColor(26, 115, 65);
      doc.roundedRect(x + 10, y + cardH - 40, 110, 24, 6, 6, "F");

      doc.setFont("helvetica", "bold");
      doc.setFontSize(9);
      doc.setTextColor(255, 255, 255);
      doc.text(
        `₹ ${Number(m.sell_price || 0).toLocaleString("en-IN")}`,
        x + 65,
        y + cardH - 24,
        { align: "center" }
      );
    }

    // Category label
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    doc.setTextColor(120, 120, 120);
    doc.text(
      m.category || "",
      x + cardW - 10,
      y + cardH - 20,
      { align: "right" }
    );

    x += cardW + gapX;

    if (x + cardW > 560) {
      x = 40;
      y += cardH + gapY;
    }
  }

  doc.save("HVF-Display-Catalog.pdf");
  return;
}


  const doc = new jsPDF({ unit: "pt", format: "a4", orientation: "portrait" });

  const selectedCategory = catalogExportCategories[0];

  const exportItems =
    selectedCategory === "ALL"
      ? items
      : items.filter((m) => m.category === selectedCategory);

  if (!exportItems.length) {
    alert("No products found for selected category.");
    return;
  }

  const loadImage = async (url) => {
    try {
      if (!url) return null;
      const res = await fetch(url);
      const blob = await res.blob();

      return await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      });
    } catch {
      return null;
    }
  };

  const imageMap = {};
  for (const item of exportItems) {
    if (item.image_url) {
      imageMap[item.id] = await loadImage(item.image_url);
    }
  }

  doc.setFont("helvetica", "bold");
  doc.setFontSize(17);
  doc.text("HVF AGENCY", 297.5, 35, { align: "center" });

  doc.setFontSize(11);
  doc.text("PRODUCT PRICE LIST", 297.5, 53, { align: "center" });

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.text(
    selectedCategory === "ALL" ? "All Categories" : selectedCategory,
    297.5,
    68,
    { align: "center" }
  );

  const grouped = exportItems.reduce((acc, item) => {
    const cat = item.category || "Uncategorized";
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(item);
    return acc;
  }, {});

  let startY = 85;

  Object.entries(grouped).forEach(([cat, products]) => {
    const head = [["Sl.", "Photo", "Product Name", "Specs / Description", "MRP"]];

    if (catalogIncludeSelling) head[0].push("Selling");
    if (catalogIncludeCost) head[0].push("Cost");

    const body = products.map((m, idx) => {
      const row = [
        idx + 1,
        "",
        m.name || "",
        m.specs || "",
        Number(m.mrp || 0).toLocaleString("en-IN"),
      ];

      if (catalogIncludeSelling) {
        row.push(Number(m.sell_price || 0).toLocaleString("en-IN"));
      }

      if (catalogIncludeCost) {
        row.push(Number(m.cost_price || 0).toLocaleString("en-IN"));
      }

      return row;
    });

    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.text(cat.toUpperCase(), 35, startY);

    autoTable(doc, {
      startY: startY + 8,
      head,
      body,
      theme: "grid",
      margin: { left: 25, right: 25 },
      styles: {
        font: "helvetica",
        fontSize: 7,
        cellPadding: 3,
        valign: "middle",
        lineColor: [120, 120, 120],
        lineWidth: 0.3,
      },
      headStyles: {
        fillColor: [90, 30, 20],
        textColor: [255, 255, 255],
        fontStyle: "bold",
        halign: "center",
      },
      alternateRowStyles: {
        fillColor: [248, 232, 226],
      },
      columnStyles: {
        0: { cellWidth: 24, halign: "center" },
        1: { cellWidth: 50, halign: "center" },
        2: { cellWidth: 95 },
        3: { cellWidth: 180 },
        4: { cellWidth: 55, halign: "right" },
        5: { cellWidth: 55, halign: "right" },
        6: { cellWidth: 55, halign: "right" },
      },
      didDrawCell: (data) => {
        if (data.section === "body" && data.column.index === 1) {
          const product = products[data.row.index];
if (!product) return;

const img = imageMap[product.id];

if (img) {
            try {
              doc.addImage(
                img,
                "JPEG",
                data.cell.x + 6,
                data.cell.y + 5,
                38,
                38
              );
            } catch {}
          }
        }
      },
      didParseCell: (data) => {
        if (data.section === "body") {
          data.cell.styles.minCellHeight = 48;
        }
      },
    });

    startY = doc.lastAutoTable.finalY + 22;

    if (startY > 760) {
      doc.addPage();
      startY = 40;
    }
  });

  doc.save(
    selectedCategory === "ALL"
      ? "HVF-Product-Price-List.pdf"
      : `HVF-${selectedCategory}-Price-List.pdf`
  );
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

const openPayrollPage = () => setPage("payroll");

const buildAttendanceSummaryForEmployee = (emp, monthName) => {
  const monthIndex = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ].indexOf(monthName);

  if (monthIndex === -1) {
    return { present: 0, absent: 0, halfday: 0, weekoff: 0, publicholiday: 0, payable: 0 };
  }

  const selectedYear = Number(attendanceDate.slice(0, 4)) || new Date().getFullYear();

  const from =
    emp.type === "contractual"
      ? `${selectedYear}-${String(monthIndex + 1).padStart(2, "0")}-01`
      : `${selectedYear}-${String(monthIndex).padStart(2, "0")}-27`;

  const lastDay = new Date(selectedYear, monthIndex + 1, 0).getDate();

  const to =
    emp.type === "contractual"
      ? `${selectedYear}-${String(monthIndex + 1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`
      : `${selectedYear}-${String(monthIndex + 1).padStart(2, "0")}-26`;

  let present = 0;
  let absent = 0;
  let halfday = 0;
  let weekoff = 0;
  let publicholiday = 0;
  let payable = 0;

  getDateRangeList(from, to).forEach((dateKey) => {
    if (emp.joining_date && new Date(dateKey) < new Date(emp.joining_date)) return;

    const key = `${dateKey}_${emp.id}`;
    const status = attendanceEntries[key];

    if (status === "present") {
      present += 1;
      payable += 1;
    } else if (status === "absent") {
      absent += 1;
    } else if (status === "halfday") {
  halfday += 1;
  payable += 0.5;
} else if (status === "weekoff") {
      weekoff += 1;
    } else if (status === "publicholiday") {
      publicholiday += 1;
      payable += 1;
    }
  });

  return { present, absent, halfday, weekoff, publicholiday, payable, from, to };
};


const getAttendanceRegisterRange = () => {
  if (attendanceRegisterMode === "custom") {
    return {
      from: attendanceRegisterFromDate,
      to: attendanceRegisterToDate,
    };
  }

  const selectedDate = new Date(attendanceDate);
  const year = selectedDate.getFullYear();
  const month = selectedDate.getMonth();

  if (attendanceTab === "contractual") {
    return {
      from: new Date(year, month, 1).toISOString().slice(0, 10),
      to: new Date(year, month + 1, 0).toISOString().slice(0, 10),
    };
  }

  return {
    from: new Date(year, month - 1, 27).toISOString().slice(0, 10),
    to: new Date(year, month, 26).toISOString().slice(0, 10),
  };
};


const getDateRangeList = (fromDate, toDate) => {
  const dates = [];

  const start = new Date(fromDate);
  const end = new Date(toDate);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return dates;
  }

  const current = new Date(start);

  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10));
    current.setDate(current.getDate() + 1);
  }

  return dates;
};

const formatExcelEmployeeDate = (value) => {
  if (!value) return "";

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }

  if (typeof value === "number") {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (!parsed) return "";

    return `${parsed.y}-${String(parsed.m).padStart(2, "0")}-${String(
      parsed.d
    ).padStart(2, "0")}`;
  }

  const text = String(value).trim();
if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
  return text;
}
  if (!text) return "";

  if (/^\d{4}$/.test(text)) {
    return `${text}-01-01`;
  }

  const parts = text.split(/[/:.\-]/).map((x) => x.trim());

  if (parts.length === 3) {
    const [a, b, c] = parts;
    const year = c.length === 2 ? `20${c}` : c;

    return `${year}-${String(b).padStart(2, "0")}-${String(a).padStart(
      2,
      "0"
    )}`;
  }

  if (parts.length === 2) {
    const [month, yearPart] = parts;
    const year = yearPart.length === 2 ? `20${yearPart}` : yearPart;

    return `${year}-${String(month).padStart(2, "0")}-01`;
  }

  return "";
};

const printAttendanceRegisterPdf = () => {
  const range = getAttendanceRegisterRange();
  const dates = getDateRangeList(range.from, range.to);

  if (!dates.length) {
    alert("Please select a valid attendance date range first.");
    return;
  }

  const employeesToPrint = payrollEmployees
  .filter(
    (emp) =>
      (attendanceTab === "all" || emp.type === attendanceTab) &&
      (emp.status || "active") === "active"
  )
  .sort((a, b) => {
    const typeOrder = {
      contractual: 1,
      non_contractual: 2,
    };

    return (typeOrder[a.type] || 99) - (typeOrder[b.type] || 99);
  });

  if (!employeesToPrint.length) {
    alert("No active employees found for this attendance type.");
    return;
  }

  const getStatusForPdf = (emp, dateKey) => {
    const key = `${dateKey}_${emp.id}`;

    const dayName = new Date(dateKey)
      .toLocaleDateString("en-US", { weekday: "long" })
      .toLowerCase();

    const joined =
      !emp.joining_date || new Date(dateKey) >= new Date(emp.joining_date);

    if (!joined) return "notjoined";

    const defaultStatus =
      emp.weekly_off &&
      emp.weekly_off !== "none" &&
      emp.weekly_off === dayName
        ? "weekoff"
        : "";

    return attendanceEntries[key] || defaultStatus;
  };

  const getLabel = (status) => {
    if (status === "present") return "P";
    if (status === "absent") return "A";
    if (status === "halfday") return "H";
    if (status === "weekoff") return "W";
    if (status === "publicholiday") return "PH";
    if (status === "notjoined") return "-";
    return "";
  };

  const getFillColor = (status) => {
    if (status === "present") return [220, 252, 231];
    if (status === "absent") return [254, 226, 226];
    if (status === "halfday") return [254, 243, 199];
    if (status === "weekoff") return [219, 234, 254];
    if (status === "publicholiday") return [237, 233, 254];
    if (status === "notjoined") return [243, 244, 246];
    return [255, 255, 255];
  };

  const getTextColor = (status) => {
    if (status === "present") return [22, 101, 52];
    if (status === "absent") return [220, 38, 38];
    if (status === "halfday") return [180, 83, 9];
    if (status === "weekoff") return [37, 99, 235];
    if (status === "publicholiday") return [124, 58, 237];
    return [17, 24, 39];
  };

  const head = [
  [
    "SL",
    "Employee",
    "P",
      "A",
      "H",
      "PH",
      "W",
      "Payable",
      ...dates.map((dateKey) => {
        const [, month, day] = dateKey.split("-");
        return `${day}/${month}`;
      }),
    ],
  ];

  const body = [];

employeesToPrint.forEach((emp, index) => {
  const showGroupHeader =
    attendanceTab === "all" &&
    (index === 0 || emp.type !== employeesToPrint[index - 1].type);

  if (showGroupHeader) {
    body.push([
  "",
  emp.type === "contractual"
        ? "CONTRACTUAL EMPLOYEES"
        : "NON-CONTRACTUAL EMPLOYEES",
      "",
      "",
      "",
      "",
      "",
      "",
      ...dates.map(() => ""),
    ]);
  }
    let present = 0;
    let absent = 0;
    let halfday = 0;
    let publicholiday = 0;
    let weekoff = 0;
    let payable = 0;

    const dateValues = dates.map((dateKey) => {
      const status = getStatusForPdf(emp, dateKey);

      if (status === "present") {
        present += 1;
        payable += 1;
      }
      if (status === "absent") absent += 1;
      if (status === "halfday") {
        halfday += 0.5;
        payable += 0.5;
      }
      if (status === "publicholiday") {
        publicholiday += 1;
        payable += 1;
      }
      if (status === "weekoff") {
        weekoff += 1;
        payable += 1;
      }

      return getLabel(status);
    });

        body.push([
  index + 1,
  emp.name,
  present,
      absent,
      halfday,
      publicholiday,
      weekoff,
      payable.toFixed(1),
      ...dateValues,
    ]);
  });

 const title =
  attendanceTab === "all"
    ? "Attendance Register"
    : attendanceTab === "contractual"
    ? "Contractual Attendance Register"
    : "Non-contractual Attendance Register";

  const doc = new jsPDF({
    orientation: "landscape",
    unit: "pt",
    format: "a4",
  });

  const pageWidth = doc.internal.pageSize.getWidth();

  doc.setFont("helvetica", "bold");
  doc.setFontSize(15);
  doc.text(`HVF Agency — ${title}`, pageWidth / 2, 28, { align: "center" });

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.text(`Period: ${range.from} to ${range.to}`, pageWidth / 2, 43, {
    align: "center",
  });

  autoTable(doc, {
    head,
    body,
    startY: 55,
    theme: "grid",
    margin: { left: 10, right: 10 },
    tableWidth: "auto",
    styles: {
      font: "helvetica",
      fontSize: dates.length > 28 ? 5.2 : 6,
      cellPadding: 2,
      lineColor: [209, 213, 219],
      lineWidth: 0.3,
      textColor: [17, 24, 39],
      halign: "center",
      valign: "middle",
      overflow: "linebreak",
    },
    headStyles: {
      fillColor: [243, 244, 246],
      textColor: [17, 24, 39],
      fontStyle: "bold",
    },
    columnStyles: {
  0: {
    cellWidth: 16,
    halign: "center",
    fontStyle: "bold",
  },
  1: {
    cellWidth: 78,
    halign: "left",
    fontStyle: "bold",
  },
  2: { cellWidth: 18, textColor: [22, 101, 52], fontStyle: "bold" },
  3: { cellWidth: 18, textColor: [220, 38, 38], fontStyle: "bold" },
  4: { cellWidth: 18, textColor: [180, 83, 9], fontStyle: "bold" },
  5: { cellWidth: 20, textColor: [124, 58, 237], fontStyle: "bold" },
  6: { cellWidth: 18, textColor: [37, 99, 235], fontStyle: "bold" },
  7: { cellWidth: 28, textColor: [29, 78, 216], fontStyle: "bold" },
},
    didParseCell: (data) => {
     if (data.section !== "body") return;

const firstCell = data.row.raw?.[0];

if (
  firstCell === "CONTRACTUAL EMPLOYEES" ||
  firstCell === "NON-CONTRACTUAL EMPLOYEES"
) {
  data.cell.styles.fillColor = [238, 242, 255];
  data.cell.styles.textColor = [30, 58, 138];
  data.cell.styles.fontStyle = "bold";
  data.cell.styles.halign = "center";
  data.cell.styles.fontSize = 7;

  if (data.column.index !== 0) {
    data.cell.text = [""];
  }

  return;
}

if (data.column.index >= 7) {

        const label = data.cell.raw;

        const status =
          label === "P"
            ? "present"
            : label === "A"
            ? "absent"
            : label === "H"
            ? "halfday"
            : label === "W"
            ? "weekoff"
            : label === "PH"
            ? "publicholiday"
            : label === "-"
            ? "notjoined"
            : "";

        data.cell.styles.fillColor = getFillColor(status);
        data.cell.styles.textColor = getTextColor(status);
        data.cell.styles.fontStyle = "bold";
      }
    },
  });

  const finalY = doc.lastAutoTable?.finalY || 55;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.text(
    "P = Present | A = Absent | H = Half Day | W = Weekly Off | PH = Public Holiday | - = Not Joined",
    pageWidth / 2,
    Math.min(finalY + 14, doc.internal.pageSize.getHeight() - 12),
    { align: "center" }
  );

  doc.save(
    `HVF-${attendanceTab}-attendance-${range.from}-to-${range.to}.pdf`
  );
};


const generateAttendanceTemplate = () => {
  if (!attendanceImportFromDate || !attendanceImportToDate) {
    alert("Please select From Date and To Date first.");
    return;
  }

  const dates = getDateRangeList(
    attendanceImportFromDate,
    attendanceImportToDate
  );

  if (!dates.length) {
    alert("Invalid date range.");
    return;
  }

  const rows = [];

    payrollEmployees.forEach((emp) => {
    rows.push({
      Employee_ID: emp.id,
      Type: emp.type === "contractual" ? "Contractual" : "Non-contractual",
      Name: emp.name,
      Branch: emp.branch || "",
      Designation: emp.designation || "",
      ...Object.fromEntries(
        dates.map((d) => {
          const [year, month, day] = d.split("-");
          return [`${day}/${month}`, ""];
        })
      ),
    });
  });

  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();

  XLSX.utils.book_append_sheet(wb, ws, "Attendance");

  XLSX.writeFile(
    wb,
    `HVF_Attendance_${attendanceImportFromDate}_to_${attendanceImportToDate}.xlsx`
  );
};

const handleAttendanceExcelImport = async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;

  if (!attendanceImportFromDate || !attendanceImportToDate) {
    alert("Please select From Date and To Date before uploading attendance.");
    event.target.value = "";
    return;
  }

  try {
    const dates = getDateRangeList(
      attendanceImportFromDate,
      attendanceImportToDate
    );

    const dateLabelToKey = {};
    dates.forEach((dateKey) => {
      const [year, month, day] = dateKey.split("-");
      dateLabelToKey[`${day}/${month}`] = dateKey;
      dateLabelToKey[dateKey] = dateKey;
    });

    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: "array" });
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];

    const rows = XLSX.utils.sheet_to_json(firstSheet, {
      defval: "",
    });

    const pendingEntries = {};
    const previewRows = [];

    rows.forEach((row) => {
      const employeeId = Number(
        row.Employee_ID || row["Employee ID"] || row.ID || row.Id
      );

      if (!employeeId) return;

      const employee = payrollEmployees.find(
        (emp) => Number(emp.id) === employeeId
      );

      let present = 0;
      let absent = 0;
      let halfday = 0;
      let weeklyOff = 0;
      let publicHoliday = 0;
      let blanks = 0;

      dates.forEach((dateKey) => {
  const [year, month, day] = dateKey.split("-");
  const label = `${day}/${month}`;

        const rawValue = String(row[label] || "").trim().toUpperCase();

        if (!rawValue) {
          blanks += 1;
          return;
        }

        let status = "";

        if (rawValue === "P") status = "present";
        if (rawValue === "A") status = "absent";
        if (rawValue === "H") status = "halfday";
        if (rawValue === "W") status = "weekoff";
        if (rawValue === "PH") status = "publicholiday";

        if (!status) {
          blanks += 1;
          return;
        }

        if (status === "present") present += 1;
        if (status === "absent") absent += 1;
        if (status === "halfday") halfday += 1;
        if (status === "weekoff") weeklyOff += 1;
        if (status === "publicholiday") publicHoliday += 1;

        pendingEntries[`${dateKey}_${employeeId}`] = status;
      });

      previewRows.push({
        employee_id: employeeId,
        employee_name: employee?.name || row.Name || "",
        type: employee?.type || row.Type || "",
        branch: employee?.branch || row.Branch || "",
        present,
        absent,
        halfday,
        weeklyOff,
        publicHoliday,
        blanks,
      });
    });

    setAttendanceImportPendingEntries(pendingEntries);
    setAttendanceImportPreviewRows(previewRows);

    event.target.value = "";
  } catch (err) {
    console.error(err);
    alert("Unable to import attendance Excel.");
  }
};

const handleEmployeeExcelImport = async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;

  try {
    const buffer = await file.arrayBuffer();

    const workbook = XLSX.read(buffer, {
      type: "array",
    });

    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];

    const rows = XLSX.utils.sheet_to_json(firstSheet, {
      defval: "",
    });

    const imported = rows.map((row, index) => ({
      id: Date.now() + index,

      type: row["Type"] || row["TYPE"] || row["Employee Type"] || "",

      name:
        row["Name"] ||
        row["Employee Name"] ||
        row["EMPLOYEE NAME"] ||
        "",

      phone:
        String(
          row["Phone"] ||
          row["Mobile"] ||
          row["PHONE"] ||
          ""
        ).trim(),

      dob: formatExcelEmployeeDate(
        row["DOB"] ||
        row["Date of Birth"] ||
        row["DATE OF BIRTH"]
      ),

      joining_date: formatExcelEmployeeDate(
        row["Joining Date"] ||
        row["JOINING DATE"] ||
        row["Date of Joining"]
      ),

      base_salary:
        Number(
          row["Salary"] ||
          row["Base Salary"] ||
          row["BASE SALARY"] ||
          0
        ) || 0,

      designation:
        row["Designation"] ||
        row["DESIGNATION"] ||
        "",

      branch:
        row["Branch"] ||
        row["BRANCH"] ||
        "",

      address:
        row["Address"] ||
        row["ADDRESS"] ||
        "",
    }));

    setEmployeeImportRows(imported);
    setShowEmployeeImport(true);

    event.target.value = "";
  } catch (err) {
    console.error(err);
    alert("Unable to read Excel file.");
  }
};


const savePayrollEmployee = () => {
  if (!employeeForm.name.trim()) {
    alert("Please enter employee name.");
    return;
  }

  if (!employeeForm.base_salary) {
    alert("Please enter base salary.");
    return;
  }

  let updatedEmployees = [];

if (editingPayrollEmployeeId) {
  updatedEmployees = payrollEmployees.map((emp) =>
    emp.id === editingPayrollEmployeeId
      ? {
  ...emp,
  ...employeeForm,
  weekly_off: employeeForm.weekly_off || "sunday",
  base_salary: Number(employeeForm.base_salary || 0),
}
      : emp
  );
} else {
  const newEmployee = {
  id: Date.now(),
  ...employeeForm,
  weekly_off: employeeForm.weekly_off || "sunday",
  base_salary: Number(employeeForm.base_salary || 0),
};

  updatedEmployees = [...payrollEmployees, newEmployee];
}

  setPayrollEmployees(updatedEmployees);
  localStorage.setItem("hvf.payrollEmployees", JSON.stringify(updatedEmployees));

  setEmployeeForm({
  type: payrollShowAll ? "contractual" : payrollTab,
  name: "",
  dob: "",
  address: "",
  joining_date: "",
  base_salary: "",
  phone: "",
  designation: "",
  branch: "",
weekly_off: "sunday",
status: "active",
});

  setShowEmployeeForm(false);
setEditingPayrollEmployeeId(null);
};

const getLocalDateKey = (date = new Date()) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
};

const getEmployeeWeeklyOffForDate = (emp, dateKey) => {
  const fallbackWeeklyOff = emp.weekly_off || "sunday";

  const history = Array.isArray(emp.weekly_off_history)
    ? emp.weekly_off_history
    : [];

  const applicableHistory = history
    .filter((item) => item.effective_from && item.effective_from <= dateKey)
    .sort((a, b) => a.effective_from.localeCompare(b.effective_from));

  if (!applicableHistory.length) {
    return fallbackWeeklyOff;
  }

  return applicableHistory[applicableHistory.length - 1].weekly_off || fallbackWeeklyOff;
};

const calculateWeeklyBonusForEmployee = (emp, fromDate, toDate) => {
  if (!emp || !fromDate || !toDate) return 0;

  let bonusDays = 0;

  const dates = getDateRangeList(fromDate, toDate);

  dates.forEach((dateKey) => {
    const dayName = new Date(dateKey)
      .toLocaleDateString("en-US", { weekday: "long" })
      .toLowerCase();

    const effectiveWeeklyOff = getEmployeeWeeklyOffForDate(emp, dateKey);

    const isWeeklyOffDay =
      effectiveWeeklyOff &&
      effectiveWeeklyOff !== "none" &&
      effectiveWeeklyOff === dayName;

    if (!isWeeklyOffDay) {
      return;
    }

    const startingBalance =
      getEmployeeStartingPayableBalance(emp, dateKey);

    const coveredTillDate = startingBalance?.coveredTillDate || "";
    const bonusCarryInDays = Number(
      startingBalance?.bonusCarryInDays || 0
    );

    let manualCarryInUsed = 0;

    // Bonus is counted only on the weekly-off date.
    // For that weekly off, check the previous 6 working days.
    const previousSixStatuses = [];

    for (let offset = 6; offset >= 1; offset -= 1) {
      const workDate = new Date(dateKey);
      workDate.setDate(workDate.getDate() - offset);

      const workDateKey = getLocalDateKey(workDate);

      if (
        emp.joining_date &&
        new Date(workDateKey) < new Date(emp.joining_date)
      ) {
        previousSixStatuses.push("notjoined");
        continue;
      }

      const workDayName = new Date(workDateKey)
        .toLocaleDateString("en-US", { weekday: "long" })
        .toLowerCase();

      const workDateWeeklyOff =
        getEmployeeWeeklyOffForDate(emp, workDateKey);

      const isWorkDateWeeklyOff =
        workDateWeeklyOff &&
        workDateWeeklyOff !== "none" &&
        workDateWeeklyOff === workDayName;

      if (isWorkDateWeeklyOff) {
        previousSixStatuses.push("weekoff");
        continue;
      }

      if (coveredTillDate && workDateKey <= coveredTillDate) {
        manualCarryInUsed += 1;

        previousSixStatuses.push(
          manualCarryInUsed <= bonusCarryInDays
            ? "present"
            : "manual_missing"
        );

        continue;
      }

      const key = `${workDateKey}_${emp.id}`;
      const status = attendanceEntries[key] || "";

      previousSixStatuses.push(status);
    }

    if (
      previousSixStatuses.length === 6 &&
      previousSixStatuses.every(
        (status) => status === "present" || status === "publicholiday"
      )
    ) {
      bonusDays += 1;
    }
  });

  return bonusDays;
};

const getPayrollPeriodDaysForEmployee = (emp, monthName) => {
  if (!emp || !monthName) return 30;

  const summary = buildAttendanceSummaryForEmployee(emp, monthName);

  if (!summary?.from || !summary?.to) return 30;

  const fromDate = new Date(summary.from);
  const toDate = new Date(summary.to);

  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
    return 30;
  }

  return (
    Math.floor((toDate - fromDate) / (1000 * 60 * 60 * 24)) + 1
  );
};

const getAdvanceCycleStartDate = (emp, selectedDate) => {
  if (!selectedDate) return "";

  const [year, month, day] = selectedDate.split("-").map(Number);

  if (!year || !month || !day) return "";

  // Contractual: 1st day of selected month.
  // This branch can be changed later when contractual rules are finalized.
  if (emp.type === "contractual") {
    return `${year}-${String(month).padStart(2, "0")}-01`;
  }

  // Non-contractual cycle:
  // 27th previous month to 26th selected month.
  if (day >= 27) {
    return `${year}-${String(month).padStart(2, "0")}-27`;
  }

  const previousMonthStart = new Date(year, month - 2, 27);

  return getLocalDateKey(previousMonthStart);
};

const calculateAdvancePayableTillDate = (
  emp,
  selectedDate = advanceDate
) => {
  const fromDate = getAdvanceCycleStartDate(emp, selectedDate);

  if (!fromDate || !selectedDate || selectedDate < fromDate) {
    return {
      fromDate: "",
      toDate: selectedDate || "",
      present: 0,
      absent: 0,
      halfday: 0,
      publicholiday: 0,
      bonus: 0,
      payableDays: 0,
      payableAmount: 0,
    };
  }

  let present = 0;
  let absent = 0;
  let halfday = 0;
  let publicholiday = 0;

  getDateRangeList(fromDate, selectedDate).forEach((dateKey) => {
    // Ignore dates before the employee joined.
    if (
      emp.joining_date &&
      new Date(dateKey) < new Date(emp.joining_date)
    ) {
      return;
    }

    const key = `${dateKey}_${emp.id}`;
    const status = attendanceEntries[key] || "";

    if (status === "present") {
      present += 1;
    } else if (status === "absent") {
      absent += 1;
    } else if (status === "halfday") {
      halfday += 1;
    } else if (status === "publicholiday") {
      publicholiday += 1;
    }
  });

  const bonusDays = Number(
    calculateWeeklyBonusForEmployee(
      emp,
      fromDate,
      selectedDate
    ) || 0
  );

  const payableDays =
    present +
    halfday * 0.5 +
    publicholiday +
    (emp.type === "non_contractual" ? bonusDays : 0);

  const payableAmount =
    (Number(emp.base_salary || 0) / 30) * payableDays;

  return {
    fromDate,
    toDate: selectedDate,
    present,
    absent,
    halfday,
    publicholiday,
    bonus: bonusDays,
    payableDays,
    payableAmount,
  };
};

const getEmployeeStartingPayableBalance = (emp, selectedDate) => {
  const emptyStartingBalance = {
    openingSalaryPayable: 0,
    openingBonusPayable: 0,
    manualAdvancePaid: 0,
    openingCarryForward: 0,
    bonusCarryInDays: 0,
    totalOpeningPayable: 0,
    referenceId: "",
    startingBalanceDate: "",
    coveredTillDate: "",
    remarks: "",
  };

  if (!emp || !selectedDate) {
    return emptyStartingBalance;
  }

  const matchingEntry = savedStartingPayableBalances
    .filter(
      (balance) =>
        balance.type === emp.type &&
        balance.startingBalanceDate &&
        balance.startingBalanceDate <= selectedDate
    )
    .flatMap((balance) =>
      (balance.entries || [])
        .filter(
          (entry) =>
            String(entry.employeeId) === String(emp.id)
        )
        .map((entry) => ({
          balance,
          entry,
        }))
    )
    .sort((a, b) => {
      const dateCompare = String(
        b.balance.startingBalanceDate || ""
      ).localeCompare(String(a.balance.startingBalanceDate || ""));

      if (dateCompare !== 0) return dateCompare;

      return String(b.balance.createdAt || "").localeCompare(
        String(a.balance.createdAt || "")
      );
    })[0];

  if (!matchingEntry) {
    return emptyStartingBalance;
  }

  const { balance, entry } = matchingEntry;

  return {
    openingSalaryPayable: Number(entry.openingSalaryPayable || 0),
    openingBonusPayable: Number(entry.openingBonusPayable || 0),
    manualAdvancePaid: Number(entry.manualAdvancePaid || 0),
    openingCarryForward: Number(entry.openingCarryForward || 0),
    bonusCarryInDays: Number(entry.bonusCarryInDays || 0),
    totalOpeningPayable: Number(entry.totalOpeningPayable || 0),
    referenceId: balance.id || "",
    startingBalanceDate: balance.startingBalanceDate || "",
    coveredTillDate: balance.coveredTillDate || "",
    remarks: entry.remarks || "",
  };
};

const getAdvanceEntryAbsentCount = (entry, batchDate) => {
  if (entry.absent !== undefined && entry.absent !== null) {
    return Number(entry.absent || 0);
  }

  const emp = payrollEmployees.find(
    (employee) => String(employee.id) === String(entry.employeeId)
  );

  if (!emp || !batchDate) return 0;

  const payableSummary = calculateAdvancePayableTillDate(emp, batchDate);

  return Number(payableSummary.absent || 0);
};




const generateHistoricalSalaryPaymentTemplate = () => {
  if (
    !historicalSalaryPaymentFromDate ||
    !historicalSalaryPaymentToDate
  ) {
    alert("Please select From Date and To Date first.");
    return;
  }

  if (
    historicalSalaryPaymentFromDate >
    historicalSalaryPaymentToDate
  ) {
    alert("From Date cannot be later than To Date.");
    return;
  }

  const matchingEmployees = payrollEmployees.filter((emp) => {
    if (emp.type !== historicalSalaryPaymentEmployeeType) {
      return false;
    }

    const joiningDate = emp.joining_date || "";

    if (
      joiningDate &&
      joiningDate > historicalSalaryPaymentToDate
    ) {
      return false;
    }

    if (
      emp.status === "left" &&
      emp.left_date &&
      emp.left_date < historicalSalaryPaymentFromDate
    ) {
      return false;
    }

    return true;
  });

  if (!matchingEmployees.length) {
    alert(
      "No employees were found for the selected employee type."
    );
    return;
  }

  const createPaymentRows = () =>
    matchingEmployees.map((emp) => ({
      Employee_ID: emp.id,
      Employee_Name: emp.name,
      Branch: emp.branch || "",
      Type:
        emp.type === "contractual"
          ? "Contractual"
          : "Non-contractual",

      Salary_Period_From_DD_MM_YYYY: "",
      Salary_Period_To_DD_MM_YYYY: "",
      Payment_Date_DD_MM_YYYY: "",
      Salary_Paid_Amount: "",
      Payment_Mode_Cash_or_Online: "",
      Remarks: "",
    }));

  const instructionsRows = [
    {
      Instructions:
        "A separate salary-payment sheet has been created for every month covered by the selected import period.",
    },
    {
      Instructions:
        "Enter salary-payment records in the applicable monthly salary sheet.",
    },
    {
      Instructions:
        "Enter Salary Period From, Salary Period To and Payment Date in DD-MM-YYYY format.",
    },
    {
      Instructions:
        "Enter only the actual salary amount paid to the employee.",
    },
    {
      Instructions:
        "Payment Mode must be either Cash or Online.",
    },
    {
      Instructions:
        "If an employee received more than one separate salary payment during the same month, copy that employee row and enter each payment separately.",
    },
    {
      Instructions:
        "Leave the salary-payment fields blank when no salary payment was made.",
    },
    {
      Instructions:
        "Do not change Employee ID, Employee Name, Branch, Type, column headings or sheet names.",
    },
  ];

  const workbook = XLSX.utils.book_new();

  const [fromYear, fromMonth] =
    historicalSalaryPaymentFromDate
      .split("-")
      .map(Number);

  const [toYear, toMonth] =
    historicalSalaryPaymentToDate
      .split("-")
      .map(Number);

  const monthNames = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];

  let currentYear = fromYear;
  let currentMonth = fromMonth;

  while (
    currentYear < toYear ||
    (currentYear === toYear &&
      currentMonth <= toMonth)
  ) {
    const paymentWorksheet =
      XLSX.utils.json_to_sheet(
        createPaymentRows()
      );

    paymentWorksheet["!cols"] = [
      { wch: 13 },
      { wch: 25 },
      { wch: 20 },
      { wch: 18 },
      { wch: 34 },
      { wch: 32 },
      { wch: 28 },
      { wch: 22 },
      { wch: 32 },
      { wch: 40 },
    ];

    paymentWorksheet["!freeze"] = {
      xSplit: 4,
      ySplit: 1,
    };

    const sheetName = `Salary ${
      monthNames[currentMonth - 1]
    } ${currentYear}`;

    XLSX.utils.book_append_sheet(
      workbook,
      paymentWorksheet,
      sheetName
    );

    currentMonth += 1;

    if (currentMonth > 12) {
      currentMonth = 1;
      currentYear += 1;
    }
  }

  const instructionsWorksheet =
    XLSX.utils.json_to_sheet(
      instructionsRows
    );

  instructionsWorksheet["!cols"] = [
    { wch: 120 },
  ];

  XLSX.utils.book_append_sheet(
    workbook,
    instructionsWorksheet,
    "Instructions"
  );

  const employeeTypeLabel =
    historicalSalaryPaymentEmployeeType ===
    "contractual"
      ? "Contractual"
      : "Non_Contractual";

  XLSX.writeFile(
    workbook,
    `HVF_Historical_Salary_Payments_${employeeTypeLabel}_${historicalSalaryPaymentFromDate}_to_${historicalSalaryPaymentToDate}.xlsx`
  );
};



const generateHistoricalAdvanceTemplate = () => {
  if (!historicalAdvanceFromDate || !historicalAdvanceToDate) {
    alert("Please select From Date and To Date first.");
    return;
  }

  if (historicalAdvanceFromDate > historicalAdvanceToDate) {
    alert("From Date cannot be later than To Date.");
    return;
  }

  const allDates = getDateRangeList(
    historicalAdvanceFromDate,
    historicalAdvanceToDate
  );

  const regularAdvanceDates = allDates.filter((dateKey) => {
    const [year, month, day] = dateKey.split("-").map(Number);

    const date = new Date(
      year,
      month - 1,
      day,
      12,
      0,
      0
    );

    const dayNumber = date.getDay();

    // Tuesday = 2, Saturday = 6
    return dayNumber === 2 || dayNumber === 6;
  });

  if (!regularAdvanceDates.length) {
    alert(
      "No Tuesday or Saturday was found within the selected date range."
    );
    return;
  }

  const matchingEmployees = payrollEmployees.filter((emp) => {
  if (emp.type !== historicalAdvanceEmployeeType) {
    return false;
  }

  const joiningDate = emp.joining_date || "";

  if (
    joiningDate &&
    joiningDate > historicalAdvanceToDate
  ) {
    return false;
  }

  if (
    emp.status === "left" &&
    emp.left_date &&
    emp.left_date < historicalAdvanceFromDate
  ) {
    return false;
  }

  return true;
});

  if (!matchingEmployees.length) {
    alert("No employees were found for the selected employee type.");
    return;
  }

  const mainRows = matchingEmployees.map((emp) => ({
    Employee_ID: emp.id,
    Employee_Name: emp.name,
    Branch: emp.branch || "",
    Type:
      emp.type === "contractual"
        ? "Contractual"
        : "Non-contractual",
    ...Object.fromEntries(
      regularAdvanceDates.map((dateKey) => {
        const [year, month, day] = dateKey.split("-");

        return [`${day}/${month}/${year}`, ""];
      })
    ),
  }));

  const otherDateRows = matchingEmployees.map((emp) => ({
    Employee_ID: emp.id,
    Employee_Name: emp.name,
    Branch: emp.branch || "",
    Type:
      emp.type === "contractual"
        ? "Contractual"
        : "Non-contractual",
    Advance_Date_DD_MM_YYYY: "",
    Advance_Amount: "",
    Payment_Mode_Cash_or_Online: "",
    Remarks: "",
  }));

  const instructionsRows = [
    {
      Instructions:
        "REGULAR ADVANCES: Enter only the advance amount below the applicable Tuesday or Saturday date.",
    },
    {
      Instructions:
        "Leave the cell blank when no advance was paid. Do not enter P, A, H, W or PH.",
    },
    {
      Instructions:
        "OTHER DATE ADVANCES: Use the second sheet for advances paid on dates other than the listed Tuesdays and Saturdays.",
    },
    {
      Instructions:
        "For other-date advances, enter the date as DD-MM-YYYY, amount, payment mode and remarks.",
    },
    {
      Instructions:
        "Do not change Employee ID, Employee Name, Branch, Type, sheet names or date headings.",
    },
  ];

  const workbook = XLSX.utils.book_new();

  const mainWorksheet = XLSX.utils.json_to_sheet(mainRows);

  mainWorksheet["!cols"] = [
    { wch: 13 },
    { wch: 25 },
    { wch: 20 },
    { wch: 18 },
    ...regularAdvanceDates.map(() => ({ wch: 13 })),
  ];

  mainWorksheet["!freeze"] = {
    xSplit: 4,
    ySplit: 1,
  };

  XLSX.utils.book_append_sheet(
    workbook,
    mainWorksheet,
    "Regular Advances"
  );

  const otherDateWorksheet =
    XLSX.utils.json_to_sheet(otherDateRows);

  otherDateWorksheet["!cols"] = [
    { wch: 13 },
    { wch: 25 },
    { wch: 20 },
    { wch: 18 },
    { wch: 25 },
    { wch: 18 },
    { wch: 30 },
    { wch: 35 },
  ];

  XLSX.utils.book_append_sheet(
    workbook,
    otherDateWorksheet,
    "Other Date Advances"
  );

  const instructionsWorksheet =
    XLSX.utils.json_to_sheet(instructionsRows);

  instructionsWorksheet["!cols"] = [{ wch: 120 }];

  XLSX.utils.book_append_sheet(
    workbook,
    instructionsWorksheet,
    "Instructions"
  );

  const employeeTypeLabel =
    historicalAdvanceEmployeeType === "contractual"
      ? "Contractual"
      : "Non_Contractual";

  XLSX.writeFile(
    workbook,
    `HVF_Historical_Advances_${employeeTypeLabel}_${historicalAdvanceFromDate}_to_${historicalAdvanceToDate}.xlsx`
  );
};


const saveParsedHistoricalAdvances = () => {
  if (
    !Array.isArray(parsedHistoricalAdvances) ||
    parsedHistoricalAdvances.length === 0
  ) {
    alert("No parsed historical advances are available to save.");
    return;
  }

  const existingAdvanceKeys = new Set();

  savedAdvanceBatches.forEach((batch) => {
    (batch.employees || []).forEach((entry) => {
      existingAdvanceKeys.add(
        [
          String(entry.employeeId || ""),
          String(batch.advanceDate || ""),
          Number(entry.advanceAmount || 0),
        ].join("|")
      );
    });
  });

  const duplicateRecords = [];
  const recordsToSave = [];

  parsedHistoricalAdvances.forEach((record) => {
    const duplicateKey = [
      String(record.employeeId || ""),
      String(record.advanceDate || ""),
      Number(record.amount || 0),
    ].join("|");

    if (existingAdvanceKeys.has(duplicateKey)) {
      duplicateRecords.push(record);
      return;
    }

    existingAdvanceKeys.add(duplicateKey);
    recordsToSave.push(record);
  });

  if (recordsToSave.length === 0) {
    alert(
      "Nothing was saved because all imported advance records already exist."
    );

    setShowHistoricalAdvanceConfirmDialog(false);
    return;
  }

  const recordsGroupedByDate = recordsToSave.reduce(
    (groups, record) => {
      const dateKey = record.advanceDate;

      if (!groups[dateKey]) {
        groups[dateKey] = [];
      }

      groups[dateKey].push(record);

      return groups;
    },
    {}
  );

  const importedAt = new Date().toISOString();

  const historicalAdvanceBatches = Object.entries(
    recordsGroupedByDate
  )
    .sort(([firstDate], [secondDate]) =>
      secondDate.localeCompare(firstDate)
    )
    .map(([advanceDate, records], batchIndex) => {
      const employees = records.map((record, recordIndex) => {
        const normalizedPaymentMode =
          String(record.paymentMode || "Cash").toLowerCase() ===
          "online"
            ? "online"
            : "cash";

        return {
          employeeId: record.employeeId,
          employeeName: record.employeeName,
          employeeType:
            record.employeeType ||
            historicalAdvanceEmployeeType,
          branch: record.branch || "",
          payableFromDate: "",
          payableToDate: advanceDate,

          grossPayable: 0,
          openingPayable: 0,
          payableDays: 0,
          present: 0,
          halfday: 0,
          absent: 0,
          publicholiday: 0,
          bonus: 0,
          previousAdvance: 0,
          carryForwardBalance: 0,
          payableBeforeAdvance: 0,

          advanceAmount: Number(record.amount || 0),
          paymentMode: normalizedPaymentMode,
          remarks:
            record.remarks ||
            "Imported historical advance",
          balanceAfterAdvance: 0,

          historicalImport: true,
          historicalImportSource:
            record.source || "historical_advance_import",
          historicalImportRecordId: `HIST-ADV-REC-${Date.now()}-${batchIndex}-${recordIndex}`,
        };
      });

      const totalCash = employees
        .filter((entry) => entry.paymentMode === "cash")
        .reduce(
          (sum, entry) =>
            sum + Number(entry.advanceAmount || 0),
          0
        );

      const totalOnline = employees
        .filter((entry) => entry.paymentMode === "online")
        .reduce(
          (sum, entry) =>
            sum + Number(entry.advanceAmount || 0),
          0
        );

      return {
        id: `HIST-ADV-${Date.now()}-${batchIndex}`,
        advanceDate,
        createdAt: importedAt,
        employees,
        totalAdvance: totalCash + totalOnline,
        totalCash,
        totalOnline,

        historicalImport: true,
        historicalImportFromDate:
          historicalAdvanceFromDate,
        historicalImportToDate:
          historicalAdvanceToDate,
        historicalImportEmployeeType:
          historicalAdvanceEmployeeType,
      };
    });

  setShowHistoricalAdvanceConfirmDialog(false);

setSavedAdvanceBatches((previous) =>
  [...historicalAdvanceBatches, ...previous].sort(
    (firstBatch, secondBatch) =>
      String(secondBatch.advanceDate || "").localeCompare(
        String(firstBatch.advanceDate || "")
      )
  )
);

setParsedHistoricalAdvances([]);

  setParsedHistoricalAdvanceSummary(null);

  if (historicalAdvanceImportInputRef.current) {
    historicalAdvanceImportInputRef.current.value = "";
  }

  setTimeout(() => {
  alert(
    `Historical advances saved successfully ✅\n\n` +
      `Records saved: ${recordsToSave.length}\n` +
      `Advance dates created: ${
        historicalAdvanceBatches.length
      }` +
      `${
        duplicateRecords.length > 0
          ? `\nDuplicate records skipped: ${duplicateRecords.length}`
          : ""
      }`
  );
}, 100);
};


const handleHistoricalSalaryPaymentTemplateUpload = (event) => {
  const file = event.target.files?.[0];

  if (!file) {
    return;
  }

  if (
    !historicalSalaryPaymentFromDate ||
    !historicalSalaryPaymentToDate
  ) {
    alert(
      "Please select the Historical Salary Payment From Date and To Date before uploading."
    );

    event.target.value = "";
    return;
  }

  const reader = new FileReader();

  reader.onload = (loadEvent) => {
    try {
      const fileData = new Uint8Array(
        loadEvent.target.result
      );

      const workbook = XLSX.read(fileData, {
  type: "array",
  cellDates: false,
});
      const salarySheetNames =
        workbook.SheetNames.filter(
          (sheetName) =>
            sheetName.startsWith("Salary ")
        );

      if (salarySheetNames.length === 0) {
        alert(
          'Invalid Historical Salary Payment Template.\n\nNo monthly salary sheets were found.\n\nExpected sheet names such as "Salary February 2026".'
        );

        return;
      }

      const parsedPayments = [];
      const importErrors = [];

      const convertInputDateToDateKey = (
        rawValue,
        fieldLabel,
        sheetName,
        rowNumber
      ) => {
        const valueText = String(
          rawValue ?? ""
        ).trim();

        if (
          rawValue instanceof Date &&
          !Number.isNaN(rawValue.getTime())
        ) {
          const year = rawValue.getFullYear();

          const month = String(
            rawValue.getMonth() + 1
          ).padStart(2, "0");

          const day = String(
            rawValue.getDate()
          ).padStart(2, "0");

          return `${year}-${month}-${day}`;
        }

        const excelSerialNumber =
          typeof rawValue === "number"
            ? rawValue
            : /^\d+(\.\d+)?$/.test(valueText)
            ? Number(valueText)
            : null;

        if (
          excelSerialNumber !== null &&
          Number.isFinite(excelSerialNumber)
        ) {
          const parsedExcelDate =
            XLSX.SSF.parse_date_code(
              excelSerialNumber
            );

          if (
            parsedExcelDate &&
            parsedExcelDate.y &&
            parsedExcelDate.m &&
            parsedExcelDate.d
          ) {
            const year = String(
              parsedExcelDate.y
            );

            const month = String(
              parsedExcelDate.m
            ).padStart(2, "0");

            const day = String(
              parsedExcelDate.d
            ).padStart(2, "0");

            return `${year}-${month}-${day}`;
          }
        }

        const dateMatch = valueText.match(
          /^(\d{2})[-/](\d{2})[-/](\d{2}|\d{4})$/
        );

        if (!dateMatch) {
          importErrors.push(
            `${sheetName}, row ${rowNumber}: Invalid ${fieldLabel} "${valueText}". Use DD-MM-YYYY.`
          );

          return "";
        }

        const [
          ,
          dayText,
          monthText,
          yearText,
        ] = dateMatch;

        const day = Number(dayText);
        const month = Number(monthText);

        const year =
          yearText.length === 2
            ? 2000 + Number(yearText)
            : Number(yearText);

        const testDate = new Date(
          year,
          month - 1,
          day,
          12,
          0,
          0
        );

        if (
          testDate.getFullYear() !== year ||
          testDate.getMonth() !==
            month - 1 ||
          testDate.getDate() !== day
        ) {
          importErrors.push(
            `${sheetName}, row ${rowNumber}: Invalid ${fieldLabel} "${valueText}".`
          );

          return "";
        }

        return `${String(year).padStart(
          4,
          "0"
        )}-${String(month).padStart(
          2,
          "0"
        )}-${String(day).padStart(2, "0")}`;
      };

      salarySheetNames.forEach(
        (sheetName) => {
          const salaryPaymentRows =
            XLSX.utils.sheet_to_json(
              workbook.Sheets[sheetName],
              {
                defval: "",
                raw: true,
              }
            );

          salaryPaymentRows.forEach(
            (row, rowIndex) => {
              const rowNumber =
                rowIndex + 2;

              const employeeId = String(
                row.Employee_ID ?? ""
              ).trim();

              const employeeName = String(
                row.Employee_Name ?? ""
              ).trim();

              const rawSalaryPeriodFrom =
                row.Salary_Period_From_DD_MM_YYYY ??
                "";

              const rawSalaryPeriodTo =
                row.Salary_Period_To_DD_MM_YYYY ??
                "";

              const rawPaymentDate =
                row.Payment_Date_DD_MM_YYYY ??
                "";

              const rawAmountValue =
                row.Salary_Paid_Amount ?? "";

              const rawPaymentMode =
                String(
                  row.Payment_Mode_Cash_or_Online ??
                    ""
                ).trim();

              const remarks = String(
                row.Remarks ?? ""
              ).trim();

              const rawSalaryPeriodFromText =
                String(
                  rawSalaryPeriodFrom
                ).trim();

              const rawSalaryPeriodToText =
                String(
                  rawSalaryPeriodTo
                ).trim();

              const rawPaymentDateText =
                String(
                  rawPaymentDate
                ).trim();

              const rawAmountText = String(
                rawAmountValue
              ).trim();

              // A blank salary amount means no salary payment was made
// for this employee in this sheet. Ignore the row even if
// the salary period, payment date or payment mode is filled.
if (!rawAmountText) {
  return;
}

              if (!employeeId) {
                importErrors.push(
                  `${sheetName}, row ${rowNumber}: Employee ID is missing.`
                );

                return;
              }

              const matchedEmployee =
                payrollEmployees.find(
                  (employee) =>
                    String(employee.id) ===
                    employeeId
                );

              if (!matchedEmployee) {
                importErrors.push(
                  `${sheetName}, row ${rowNumber}: Employee ID "${employeeId}" was not found.`
                );

                return;
              }

              if (
                matchedEmployee.type !==
                historicalSalaryPaymentEmployeeType
              ) {
                importErrors.push(
                  `${sheetName}, row ${rowNumber}: ${
                    matchedEmployee.name
                  } does not belong to the selected ${
                    historicalSalaryPaymentEmployeeType ===
                    "contractual"
                      ? "Contractual"
                      : "Non-contractual"
                  } employee type.`
                );

                return;
              }

              if (
                !rawSalaryPeriodFromText ||
                !rawSalaryPeriodToText ||
                !rawPaymentDateText ||
                !rawAmountText
              ) {
                importErrors.push(
                  `${sheetName}, row ${rowNumber}: Salary Period From, Salary Period To, Payment Date and Salary Paid Amount are required.`
                );

                return;
              }

              const salaryPeriodFrom =
                convertInputDateToDateKey(
                  rawSalaryPeriodFrom,
                  "Salary Period From",
                  sheetName,
                  rowNumber
                );

              const salaryPeriodTo =
                convertInputDateToDateKey(
                  rawSalaryPeriodTo,
                  "Salary Period To",
                  sheetName,
                  rowNumber
                );

              const paymentDate =
                convertInputDateToDateKey(
                  rawPaymentDate,
                  "Payment Date",
                  sheetName,
                  rowNumber
                );

              if (
                !salaryPeriodFrom ||
                !salaryPeriodTo ||
                !paymentDate
              ) {
                return;
              }

              if (
                salaryPeriodFrom >
                salaryPeriodTo
              ) {
                importErrors.push(
                  `${sheetName}, row ${rowNumber}: Salary Period From cannot be later than Salary Period To.`
                );

                return;
              }

              // Payment date may fall after the selected salary-period range.
// Example: salary period ending 26-06-2026 may be paid on 03-07-2026.
// Therefore, do not reject the row based on the payment date.

              const amount =
                typeof rawAmountValue ===
                "number"
                  ? rawAmountValue
                  : Number(
                      rawAmountText.replace(
                        /,/g,
                        ""
                      )
                    );

              if (
                !Number.isFinite(amount) ||
                amount <= 0
              ) {
                importErrors.push(
                  `${sheetName}, row ${rowNumber}: Invalid salary paid amount "${rawAmountText}".`
                );

                return;
              }

              const normalizedPaymentMode =
                rawPaymentMode.toLowerCase();

              let paymentMode = "Cash";

              if (
                normalizedPaymentMode ===
                "online"
              ) {
                paymentMode = "Online";
              } else if (
                normalizedPaymentMode &&
                normalizedPaymentMode !==
                  "cash"
              ) {
                importErrors.push(
                  `${sheetName}, row ${rowNumber}: Payment mode must be Cash or Online.`
                );

                return;
              }

              parsedPayments.push({
                employeeId,
                employeeName:
                  matchedEmployee.name ||
                  employeeName,
                branch:
                  matchedEmployee.branch ||
                  "",
                employeeType:
                  matchedEmployee.type,
                salaryPeriodFrom,
                salaryPeriodTo,
                paymentDate,
                amount,
                paymentMode,
                remarks:
                  remarks ||
                  "Imported historical salary payment",
                source:
                  "historical_salary_payment_import",
                sourceSheet: sheetName,
              });
            }
          );
        }
      );

      if (importErrors.length > 0) {
        alert(
          `Historical Salary Payment Import failed.\n\n${importErrors
            .slice(0, 20)
            .join("\n")}${
            importErrors.length > 20
              ? `\n\n...and ${
                  importErrors.length - 20
                } more error(s).`
              : ""
          }`
        );

        return;
      }

      if (parsedPayments.length === 0) {
        alert(
          "No historical salary payment records were found in the uploaded monthly salary sheets."
        );

        return;
      }

      const uniqueEmployeeIds = new Set(
        parsedPayments.map(
          (payment) => payment.employeeId
        )
      );

      const cashAmount = parsedPayments
        .filter(
          (payment) =>
            payment.paymentMode === "Cash"
        )
        .reduce(
          (sum, payment) =>
            sum +
            Number(payment.amount || 0),
          0
        );

      const onlineAmount = parsedPayments
        .filter(
          (payment) =>
            payment.paymentMode ===
            "Online"
        )
        .reduce(
          (sum, payment) =>
            sum +
            Number(payment.amount || 0),
          0
        );

      const summary = {
        employeeCount:
          uniqueEmployeeIds.size,
        paymentCount:
          parsedPayments.length,
        cashCount:
          parsedPayments.filter(
            (payment) =>
              payment.paymentMode ===
              "Cash"
          ).length,
        onlineCount:
          parsedPayments.filter(
            (payment) =>
              payment.paymentMode ===
              "Online"
          ).length,
        cashAmount,
        onlineAmount,
        totalAmount:
          cashAmount + onlineAmount,
      };

      setParsedHistoricalSalaryPayments(
        parsedPayments
      );

      setParsedHistoricalSalaryPaymentSummary(
        summary
      );

      setShowHistoricalSalaryPaymentConfirmDialog(
        true
      );
    } catch (error) {
      console.error(
        "Historical salary payment import failed:",
        error
      );

      alert(
        "Could not read the Historical Salary Payment Excel file. Please generate a fresh template and try again."
      );
    } finally {
      if (
        historicalSalaryPaymentImportInputRef.current
      ) {
        historicalSalaryPaymentImportInputRef.current.value =
          "";
      }
    }
  };

  reader.onerror = () => {
    alert(
      "Could not read the selected Historical Salary Payment Excel file."
    );

    if (
      historicalSalaryPaymentImportInputRef.current
    ) {
      historicalSalaryPaymentImportInputRef.current.value =
        "";
    }
  };

  reader.readAsArrayBuffer(file);
};


const saveParsedHistoricalSalaryPayments = () => {
  if (!parsedHistoricalSalaryPayments.length) {
    return;
  }

  const existingBatches = [
  ...savedHistoricalSalaryPaymentBatches,
];

const existingKeys = new Set();

existingBatches.forEach((batch) => {
  (batch.payments || []).forEach((payment) => {
    existingKeys.add(
      [
        payment.employeeId,
        payment.salaryPeriodFrom,
        payment.salaryPeriodTo,
        payment.paymentDate,
        Number(payment.amount).toFixed(2),
      ].join("|")
    );
  });
});

const newPayments = [];
const duplicatePayments = [];

parsedHistoricalSalaryPayments.forEach((payment) => {
  const key = [
    payment.employeeId,
    payment.salaryPeriodFrom,
    payment.salaryPeriodTo,
    payment.paymentDate,
    Number(payment.amount).toFixed(2),
  ].join("|");

  if (existingKeys.has(key)) {
    duplicatePayments.push(payment);
    return;
  }

  existingKeys.add(key);
  newPayments.push(payment);
});

if (!newPayments.length) {
  alert(
    "All selected Historical Salary Payments already exist."
  );

  setShowHistoricalSalaryPaymentConfirmDialog(false);
  return;
}

const groupedPayments = {};

newPayments.forEach((payment) => {
  if (!groupedPayments[payment.paymentDate]) {
    groupedPayments[payment.paymentDate] = [];
  }

  groupedPayments[payment.paymentDate].push(payment);
});

Object.entries(groupedPayments).forEach(
  ([paymentDate, payments]) => {
    existingBatches.push({
      id:
        "salary-import-" +
        Date.now() +
        "-" +
        Math.random().toString(36).slice(2, 8),

      source: "historical_salary_payment_import",

      paymentDate,

      createdAt: new Date().toISOString(),

      employeeType:
        historicalSalaryPaymentEmployeeType,

      periodFrom:
        historicalSalaryPaymentFromDate,

      periodTo:
        historicalSalaryPaymentToDate,

      payments,
    });
  }
);

setSavedHistoricalSalaryPaymentBatches(
  existingBatches
);

setParsedHistoricalSalaryPayments([]);

setParsedHistoricalSalaryPaymentSummary(null);

setShowHistoricalSalaryPaymentConfirmDialog(false);

setTimeout(() => {
  alert(
    `Historical Salary Payment Import completed successfully.\n\nImported ${newPayments.length} payment(s).${
      duplicatePayments.length
        ? `\nSkipped ${duplicatePayments.length} duplicate payment(s).`
        : ""
    }`
  );
}, 0);

return;
};

const handleHistoricalAdvanceTemplateUpload = (event) => {

  const file = event.target.files?.[0];

  if (!file) {
    return;
  }

  const reader = new FileReader();

  reader.onload = (loadEvent) => {
    try {
      const fileData = new Uint8Array(
        loadEvent.target.result
      );

      const workbook = XLSX.read(fileData, {
        type: "array",
      });

      const requiredSheets = [
        "Regular Advances",
        "Other Date Advances",
      ];

      const missingSheets = requiredSheets.filter(
        (sheetName) =>
          !workbook.SheetNames.includes(sheetName)
      );

      if (missingSheets.length > 0) {
        alert(
          `Invalid Historical Advance Template.\n\nMissing sheet(s): ${missingSheets.join(
            ", "
          )}`
        );

        return;
      }

      const regularAdvanceRows = XLSX.utils.sheet_to_json(
  workbook.Sheets["Regular Advances"],
  {
    defval: "",
  }
);

const otherDateRows = XLSX.utils.sheet_to_json(
  workbook.Sheets["Other Date Advances"],
  {
    defval: "",
  }
);

const parsedRegularAdvances = [];
const parsedOtherDateAdvances = [];
const importErrors = [];

const metadataColumns = new Set([
  "Employee_ID",
  "Employee_Name",
  "Branch",
  "Type",
]);

const convertHeadingToDateKey = (heading) => {
  const match = String(heading)
    .trim()
    .match(/^(\d{2})\/(\d{2})\/(\d{4})$/);

  if (!match) {
    return "";
  }

  const [, day, month, year] = match;

  return `${year}-${month}-${day}`;
};

regularAdvanceRows.forEach((row, rowIndex) => {
  const employeeId = String(
    row.Employee_ID ?? ""
  ).trim();

  const employeeName = String(
    row.Employee_Name ?? ""
  ).trim();

  if (!employeeId) {
    return;
  }

  Object.entries(row).forEach(
    ([columnName, rawValue]) => {
      if (metadataColumns.has(columnName)) {
        return;
      }

      const advanceDate =
        convertHeadingToDateKey(columnName);

      if (!advanceDate) {
        return;
      }

      const valueText = String(
        rawValue ?? ""
      ).trim();

      if (!valueText) {
        return;
      }

      const amount = Number(
        valueText.replace(/,/g, "")
      );

      if (
        !Number.isFinite(amount) ||
        amount <= 0
      ) {
        importErrors.push(
          `Regular Advances row ${
            rowIndex + 2
          }: Invalid amount "${valueText}" for ${
            employeeName || employeeId
          } on ${columnName}.`
        );

        return;
      }

      parsedRegularAdvances.push({
        employeeId,
        employeeName,
        branch: String(
          row.Branch ?? ""
        ).trim(),
        employeeType: String(
          row.Type ?? ""
        ).trim(),
        advanceDate,
        amount,
        paymentMode: "Cash",
        remarks:
          "Imported historical regular advance",
        source: "historical_regular_import",
      });
    }
  );
});

otherDateRows.forEach((row, rowIndex) => {
  const employeeId = String(
    row.Employee_ID ?? ""
  ).trim();

  const employeeName = String(
    row.Employee_Name ?? ""
  ).trim();

  const rawDate = String(
    row.Advance_Date_DD_MM_YYYY ?? ""
  ).trim();

  const rawAmount = String(
    row.Advance_Amount ?? ""
  ).trim();

  const rawPaymentMode = String(
    row.Payment_Mode_Cash_or_Online ?? ""
  ).trim();

  const remarks = String(
    row.Remarks ?? ""
  ).trim();

  if (
    !rawDate &&
    !rawAmount &&
    !rawPaymentMode &&
    !remarks
  ) {
    return;
  }

  if (!employeeId) {
    importErrors.push(
      `Other Date Advances row ${
        rowIndex + 2
      }: Employee ID is missing.`
    );

    return;
  }

  if (!rawDate && !rawAmount) {
    return;
  }

  const dateMatch = rawDate.match(
    /^(\d{2})[-/](\d{2})[-/](\d{4})$/
  );

  if (!dateMatch) {
    importErrors.push(
      `Other Date Advances row ${
        rowIndex + 2
      }: Invalid date "${rawDate}". Use DD-MM-YYYY.`
    );

    return;
  }

  const [, day, month, year] = dateMatch;
  const advanceDate = `${year}-${month}-${day}`;

  const amount = Number(
    rawAmount.replace(/,/g, "")
  );

  if (
    !Number.isFinite(amount) ||
    amount <= 0
  ) {
    importErrors.push(
      `Other Date Advances row ${
        rowIndex + 2
      }: Invalid amount "${rawAmount}" for ${
        employeeName || employeeId
      }.`
    );

    return;
  }

  const normalizedPaymentMode =
    rawPaymentMode.toLowerCase();

  let paymentMode = "Cash";

  if (normalizedPaymentMode === "online") {
    paymentMode = "Online";
  } else if (
    normalizedPaymentMode &&
    normalizedPaymentMode !== "cash"
  ) {
    importErrors.push(
      `Other Date Advances row ${
        rowIndex + 2
      }: Payment mode must be Cash or Online.`
    );

    return;
  }

  parsedOtherDateAdvances.push({
    employeeId,
    employeeName,
    branch: String(
      row.Branch ?? ""
    ).trim(),
    employeeType: String(
      row.Type ?? ""
    ).trim(),
    advanceDate,
    amount,
    paymentMode,
    remarks:
      remarks ||
      "Imported historical other-date advance",
    source: "historical_other_date_import",
  });
});

if (importErrors.length > 0) {
  console.error(
    "Historical Advance Import Errors:",
    importErrors
  );

  alert(
    `The template contains ${
      importErrors.length
    } error(s).\n\n${importErrors
      .slice(0, 10)
      .join("\n")}${
      importErrors.length > 10
        ? `\n\nAnd ${
            importErrors.length - 10
          } more error(s).`
        : ""
    }\n\nNothing has been saved.`
  );

  return;
}

const allParsedAdvances = [
  ...parsedRegularAdvances,
  ...parsedOtherDateAdvances,
];

if (!allParsedAdvances.length) {
  setParsedHistoricalAdvances([]);
  setParsedHistoricalAdvanceSummary(null);

  alert(
    "The template was read successfully, but no filled advance amounts were found."
  );

  return;
}

const affectedEmployeeIds = new Set(
  allParsedAdvances.map(
    (entry) => entry.employeeId
  )
);

const totalAdvanceAmount =
  allParsedAdvances.reduce(
    (total, entry) =>
      total + Number(entry.amount || 0),
    0
  );

const summary = {
  employeeCount: affectedEmployeeIds.size,
  regularCount: parsedRegularAdvances.length,
  otherCount: parsedOtherDateAdvances.length,
  totalCount: allParsedAdvances.length,
  totalAmount: totalAdvanceAmount,
};

setParsedHistoricalAdvances(
  allParsedAdvances
);

setParsedHistoricalAdvanceSummary(
  summary
);

console.log(
  "Parsed Historical Advances:",
  allParsedAdvances
);

setShowHistoricalAdvanceConfirmDialog(true);

    } catch (error) {
      console.error(
        "Historical advance template upload error:",
        error
      );

      alert(
        "The selected Excel file could not be read. Please upload the generated Historical Advance Template."
      );
    } finally {
      event.target.value = "";
    }
  };

  reader.onerror = () => {
    alert("The selected Excel file could not be read.");
    event.target.value = "";
  };

  reader.readAsArrayBuffer(file);
};

const downloadAdvanceSummaryPdf = async (batch) => {
  if (!batch?.employees?.length) {
    alert("No advance summary is available to download.");
    return;
  }

  const formatDisplayDate = (dateValue) =>
    dateValue
      ? dateValue.split("-").reverse().join("-")
      : "—";

  const formatAmount = (amount) =>
    Math.round(Number(amount || 0)).toLocaleString("en-IN");

  const doc = new jsPDF({
    orientation: "landscape",
    unit: "pt",
    format: "a4",
  });

  try {
    await loadRupeeFont(doc);
  } catch (error) {
    console.error("Advance PDF font could not be loaded:", error);
  }

  const pageWidth = doc.internal.pageSize.getWidth();
  const advanceDateText = formatDisplayDate(batch.advanceDate);

  const savedAtText = batch.createdAt
    ? (() => {
        const savedDate = new Date(batch.createdAt);

        const day = String(savedDate.getDate()).padStart(2, "0");
        const month = String(savedDate.getMonth() + 1).padStart(2, "0");
        const year = savedDate.getFullYear();

        const hours = String(savedDate.getHours()).padStart(2, "0");
        const minutes = String(savedDate.getMinutes()).padStart(2, "0");

        return `${day}-${month}-${year} ${hours}:${minutes}`;
      })()
    : "—";

  const pdfFont =
    doc.getFontList?.()?.NotoSans
      ? "NotoSans"
      : "helvetica";

  doc.setFont(pdfFont, "bold");
  doc.setFontSize(17);
  doc.text(
    "HVF Agency — Advance Payment Summary",
    pageWidth / 2,
    32,
    { align: "center" }
  );

  doc.setFont(pdfFont, "normal");
  doc.setFontSize(10);
  doc.text(
    `Advance Date: ${advanceDateText}`,
    pageWidth / 2,
    49,
    { align: "center" }
  );

  doc.setFontSize(8);
  doc.text(
    `Reference: ${batch.id || "—"}  |  Employees: ${
      batch.employees.length
    }`,
    pageWidth / 2,
    63,
    { align: "center" }
  );

  doc.text(
  `Saved At: ${savedAtText}`,
  pageWidth / 2,
  76,
  { align: "center" }
);

doc.setFontSize(7);
doc.setTextColor(107, 114, 128);
doc.text(
  "Attendance: P = Present | H = Half Day | A = Absent | PH = Public Holiday | B = Bonus",
  pageWidth / 2,
  87,
  { align: "center" }
);

const tableBody = batch.employees.map((entry, index) => {

    const balance = Number(entry.balanceAfterAdvance || 0);

    const payablePeriod = `${
      formatDisplayDate(entry.payableFromDate)
    }\nto\n${formatDisplayDate(entry.payableToDate)}`;

    const grossPayable = Number(
      entry.grossPayable ??
        Number(entry.payableBeforeAdvance || 0) +
          Number(entry.previousAdvance || 0)
    );

   const previousAdvance = Number(entry.previousAdvance || 0);

const carryForwardBalance = Number(
  entry.carryForwardBalance || 0
);

const availableBeforeAdvance = Number(
  entry.payableBeforeAdvance || 0
);

const openingPayable = Number(entry.openingPayable || 0);

const startingBalanceNote =
  openingPayable !== 0
    ? `\nIncludes Starting: ${
        openingPayable < 0 ? "−" : ""
      }₹${formatAmount(Math.abs(openingPayable))}`
    : "";

return [
  index + 1,
  entry.remarks
    ? `${entry.employeeName || "—"}\nRemarks: ${entry.remarks}`
    : entry.employeeName || "—",
  entry.employeeType === "contractual"
    ? "Contractual\nLogic pending"
    : "Non-contractual",
  entry.branch || "—",
  payablePeriod,
       `₹${formatAmount(grossPayable)}\nDays: ${Number(
  entry.payableDays || 0
).toFixed(1)}\nP: ${Number(entry.present || 0)} • H: ${Number(
  entry.halfday || 0
)} • A: ${getAdvanceEntryAbsentCount(entry, batch.advanceDate)} • PH: ${Number(
  entry.publicholiday || 0
)} • B: ${Number(entry.bonus || 0)}`,
      `₹${formatAmount(previousAdvance)}`,
  `${carryForwardBalance < 0 ? "−" : ""}₹${formatAmount(
    Math.abs(carryForwardBalance)
  )}`,
  `${availableBeforeAdvance < 0 ? "−" : ""}₹${formatAmount(
    Math.abs(availableBeforeAdvance)
  )}${startingBalanceNote}`,

  `₹${formatAmount(entry.advanceAmount)}`,
  entry.paymentMode === "cash" ? "Cash" : "Online",
  `${balance < 0 ? "−" : ""}₹${formatAmount(
    Math.abs(balance)
  )}${balance < 0 ? "\nExcess / carry forward" : ""}`,
];
  });

  autoTable(doc, {
    startY: 102,
   head: [
  [
    "SL",
    "Employee",
    "Type",
    "Branch",
    "Payable Period",
    "Gross Payable",
    "Prev Advances",
    "Carry Forward",
    "Available Before",
    "Current Advance",
    "Mode",
    "Balance After",
  ],
],
    body: tableBody,
    theme: "grid",
    margin: {
      left: 24,
      right: 24,
    },
    styles: {
      font: pdfFont,
      fontSize: 6.5,
      cellPadding: 5,
      lineColor: [209, 213, 219],
      lineWidth: 0.4,
      textColor: [17, 24, 39],
      valign: "middle",
    },
    headStyles: {
      font: pdfFont,
      fontStyle: "bold",
      fillColor: [220, 252, 231],
      textColor: [22, 101, 52],
      halign: "center",
    },
    columnStyles: {
  0: {
    cellWidth: 22,
    halign: "center",
  },
  1: {
    cellWidth: 84,
    fontStyle: "bold",
  },
  2: {
    cellWidth: 60,
  },
  3: {
    cellWidth: 70,
  },
  4: {
    cellWidth: 68,
    halign: "center",
  },
  5: {
    cellWidth: 62,
    halign: "right",
    textColor: [22, 101, 52],
    fontStyle: "bold",
  },
  6: {
    cellWidth: 62,
    halign: "right",
    textColor: [220, 38, 38],
    fontStyle: "bold",
  },
  7: {
    cellWidth: 68,
    halign: "right",
    textColor: [220, 38, 38],
    fontStyle: "bold",
  },
  8: {
    cellWidth: 74,
    halign: "right",
    fontStyle: "bold",
  },
  9: {
    cellWidth: 62,
    halign: "right",
    textColor: [180, 83, 9],
    fontStyle: "bold",
  },
  10: {
    cellWidth: 44,
    halign: "center",
  },
  11: {
    cellWidth: 78,
    halign: "right",
    fontStyle: "bold",
  },
},

    didParseCell: (data) => {
      if (
        data.section === "body" &&
        data.column.index === 11
      ) {
        const employeeEntry =
          batch.employees[data.row.index];

        if (
          Number(employeeEntry?.balanceAfterAdvance || 0) < 0
        ) {
          data.cell.styles.textColor = [220, 38, 38];
        } else {
          data.cell.styles.textColor = [22, 101, 52];
        }
      }
    },
  });

  const totalsY =
    (doc.lastAutoTable?.finalY || 90) + 24;

  doc.setFont(pdfFont, "bold");
  doc.setFontSize(10);

  doc.setTextColor(22, 101, 52);
  doc.text(
    `Cash Total: ₹${formatAmount(batch.totalCash)}`,
    30,
    totalsY
  );

  doc.setTextColor(37, 99, 235);
  doc.text(
    `Online Total: ₹${formatAmount(batch.totalOnline)}`,
    pageWidth / 2,
    totalsY,
    { align: "center" }
  );

  doc.setTextColor(180, 83, 9);
  doc.text(
    `Grand Total Advance: ₹${formatAmount(
      batch.totalAdvance
    )}`,
    pageWidth - 30,
    totalsY,
    { align: "right" }
  );

  doc.setTextColor(17, 24, 39);
  doc.setFont(pdfFont, "normal");
  doc.setFontSize(8);

  doc.text(
    "Generated from the HVF Payroll & Attendance system.",
    pageWidth / 2,
    totalsY + 18,
    { align: "center" }
  );

  doc.save(
    `Advance_Summary_${advanceDateText}.pdf`
  );
};

const downloadAdvanceVoucherPdf = async (batch) => {
  if (!batch?.employees?.length) {
    alert("No advance voucher data is available.");
    return;
  }

  const formatDisplayDate = (dateValue) =>
    dateValue
      ? dateValue.split("-").reverse().join("-")
      : "—";

  const formatAmount = (amount) =>
    Math.round(Number(amount || 0)).toLocaleString("en-IN");

  const doc = new jsPDF({
    orientation: "portrait",
    unit: "pt",
    format: "a4",
  });

  try {
    await loadRupeeFont(doc);
  } catch (error) {
    console.error("Advance voucher PDF font could not be loaded:", error);
  }

  const pdfFont =
    doc.getFontList?.()?.NotoSans
      ? "NotoSans"
      : "helvetica";

  const savedAtText = batch.createdAt
    ? (() => {
        const savedDate = new Date(batch.createdAt);

        const day = String(savedDate.getDate()).padStart(2, "0");
        const month = String(savedDate.getMonth() + 1).padStart(2, "0");
        const year = savedDate.getFullYear();

        const hours = String(savedDate.getHours()).padStart(2, "0");
        const minutes = String(savedDate.getMinutes()).padStart(2, "0");

        return `${day}-${month}-${year} ${hours}:${minutes}`;
      })()
    : "—";

 const pageWidth = doc.internal.pageSize.getWidth();
const pageHeight = doc.internal.pageSize.getHeight();

const margin = 16;
const gapX = 10;
const gapY = 8;

const voucherWidth = (pageWidth - margin * 2 - gapX) / 2;
const voucherHeight = (pageHeight - margin * 2 - gapY * 2) / 3;

const drawVoucher = (entry, index) => {
  const positionOnPage = index % 6;
  const column = positionOnPage % 2;
  const row = Math.floor(positionOnPage / 2);

  if (index > 0 && positionOnPage === 0) {
    doc.addPage();
  }

  const x = margin + column * (voucherWidth + gapX);
  const y = margin + row * (voucherHeight + gapY);

  const balance = Number(entry.balanceAfterAdvance || 0);
  const grossPayable = Number(
    entry.grossPayable ??
      Number(entry.payableBeforeAdvance || 0) +
        Number(entry.previousAdvance || 0)
  );

  doc.setDrawColor(156, 163, 175);
  doc.setLineWidth(0.8);
  doc.roundedRect(x, y, voucherWidth, voucherHeight, 6, 6);

  doc.setFont(pdfFont, "bold");
  doc.setFontSize(11);
  doc.setTextColor(17, 24, 39);
  doc.text("HVF Agency", x + voucherWidth / 2, y + 16, {
    align: "center",
  });

  doc.setFontSize(8.5);
  doc.text("Advance Payment Voucher", x + voucherWidth / 2, y + 28, {
    align: "center",
  });

  doc.setFont(pdfFont, "normal");
  doc.setFontSize(7);
  doc.setTextColor(75, 85, 99);

  doc.text(
    `Date: ${formatDisplayDate(batch.advanceDate)}`,
    x + 10,
    y + 40
  );

  doc.text(`Ref: ${batch.id || "—"}`, x + voucherWidth - 10, y + 40, {
    align: "right",
  });

  doc.text(`Saved: ${savedAtText}`, x + voucherWidth / 2, y + 50, {
    align: "center",
  });

  doc.setDrawColor(229, 231, 235);
  doc.line(x + 10, y + 56, x + voucherWidth - 10, y + 56);

  const labelX = x + 12;
  const valueX = x + voucherWidth - 12;
  const valueMaxWidth = voucherWidth - 118;
  const signatureLineY = y + voucherHeight - 26;
  let textY = y + 68;

  const drawRow = (label, value, options = {}) => {
    const text = String(value ?? "—");
    const fontSize = options.big ? 8.5 : 7;
    const lineHeight = options.big ? 8 : 7;
    const gap = options.gap ?? 3;

    doc.setFont(pdfFont, "normal");
    doc.setFontSize(7);
    doc.setTextColor(107, 114, 128);
    doc.text(label, labelX, textY);

    doc.setFont(pdfFont, options.bold ? "bold" : "normal");
    doc.setFontSize(fontSize);
    doc.setTextColor(...(options.color || [17, 24, 39]));

    const valueLines = doc.splitTextToSize(
      text,
      options.maxWidth || valueMaxWidth
    );

    doc.text(valueLines, valueX, textY, { align: "right" });

    textY += Math.max(lineHeight, valueLines.length * lineHeight) + gap;
  };

  drawRow("Employee", entry.employeeName || "—", {
    bold: true,
    maxWidth: valueMaxWidth,
  });

  if (entry.remarks) {
    drawRow("Remarks", entry.remarks, {
      color: [146, 64, 14],
      maxWidth: valueMaxWidth,
      gap: 2,
    });
  }

  drawRow(
    "Type",
    entry.employeeType === "contractual"
      ? "Contractual - Logic pending"
      : "Non-contractual"
  );

  drawRow("Branch", entry.branch || "—", {
    maxWidth: valueMaxWidth,
  });

  drawRow("Gross Payable", `₹${formatAmount(grossPayable)}`, {
    color: [22, 101, 52],
  });

  drawRow(
    "Payable Days",
    `${Number(entry.payableDays || 0).toFixed(1)} days`,
    { color: [75, 85, 99] }
  );

  drawRow(
  "Attendance",
  `P:${Number(entry.present || 0)} H:${Number(
    entry.halfday || 0
  )} A:${getAdvanceEntryAbsentCount(entry, batch.advanceDate)} PH:${Number(
    entry.publicholiday || 0
  )} B:${Number(entry.bonus || 0)}`,
  {
    color: [75, 85, 99],
    maxWidth: valueMaxWidth,
  }
);

  drawRow("Previous Advances", `₹${formatAmount(entry.previousAdvance)}`, {
    color: [220, 38, 38],
  });

  drawRow(
    "Previous Carry Forward",
    `${Number(entry.carryForwardBalance || 0) < 0 ? "−" : ""}₹${formatAmount(
      Math.abs(Number(entry.carryForwardBalance || 0))
    )}`,
    { color: [220, 38, 38] }
  );

  drawRow(
    "Available Before Advance",
    `${Number(entry.payableBeforeAdvance || 0) < 0 ? "−" : ""}₹${formatAmount(
      Math.abs(Number(entry.payableBeforeAdvance || 0))
    )}${
      Number(entry.openingPayable || 0) !== 0
        ? `\nIncl. Start: ${
            Number(entry.openingPayable || 0) < 0 ? "−" : ""
          }₹${formatAmount(Math.abs(Number(entry.openingPayable || 0)))}`
        : ""
    }`,
    {
      bold: true,
      gap: Number(entry.openingPayable || 0) !== 0 ? 2 : 3,
    }
  );

  drawRow("Advance Paid", `₹${formatAmount(entry.advanceAmount)}`, {
    bold: true,
    big: true,
    color: [180, 83, 9],
    gap: 4,
  });

  drawRow(
    "Payment Mode",
    entry.paymentMode === "cash" ? "Cash" : "Online",
    { bold: true }
  );

  drawRow(
    "Balance After Advance",
    `${balance < 0 ? "−" : ""}₹${formatAmount(Math.abs(balance))}`,
    {
      bold: true,
      color: balance < 0 ? [220, 38, 38] : [22, 101, 52],
    }
  );

  if (balance < 0) {
    drawRow("Note", "Excess / carry forward", {
      bold: true,
      color: [220, 38, 38],
      maxWidth: valueMaxWidth,
    });
  }

  doc.setDrawColor(209, 213, 219);
  doc.line(x + 12, signatureLineY, x + voucherWidth - 12, signatureLineY);

  doc.setFont(pdfFont, "normal");
  doc.setFontSize(6.5);
  doc.setTextColor(107, 114, 128);
  doc.text("Employee Signature", x + 14, signatureLineY + 10);
  doc.text(
    "Authorized Signature",
    x + voucherWidth - 14,
    signatureLineY + 10,
    { align: "right" }
  );
};

batch.employees.forEach((entry, index) => {
  drawVoucher(entry, index);
});

doc.save(`Advance_Vouchers_${formatDisplayDate(batch.advanceDate)}.pdf`);
};

const getPayrollCycleRangeForEmployee = (emp, monthName) => {
  const monthNames = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];

  const monthIndex = monthNames.indexOf(monthName);

  if (monthIndex === -1) {
    return {
      fromDate: "",
      toDate: "",
    };
  }

  const referenceDate = attendanceDate
    ? new Date(`${attendanceDate}T00:00:00`)
    : new Date();

  let selectedYear = referenceDate.getFullYear();

  // Allows December payroll to work correctly when viewed in January.
  if (monthIndex > referenceDate.getMonth()) {
    selectedYear -= 1;
  }

  let fromDate;
  let toDate;

  if (emp.type === "contractual") {
    fromDate = new Date(selectedYear, monthIndex, 1);
    toDate = new Date(selectedYear, monthIndex + 1, 0);
  } else {
    fromDate = new Date(selectedYear, monthIndex - 1, 27);
    toDate = new Date(selectedYear, monthIndex, 26);
  }

  return {
    fromDate: getLocalDateKey(fromDate),
    toDate: getLocalDateKey(toDate),
  };
};

const getEmployeeStartingPayableBalanceForPayroll = (emp, monthName) => {
  const { toDate } = getPayrollCycleRangeForEmployee(emp, monthName);

  if (!toDate) {
    return {
      openingSalaryPayable: 0,
      openingBonusPayable: 0,
      manualAdvancePaid: 0,
      openingCarryForward: 0,
      bonusCarryInDays: 0,
      totalOpeningPayable: 0,
      referenceId: "",
      startingBalanceDate: "",
      coveredTillDate: "",
      remarks: "",
    };
  }

  return getEmployeeStartingPayableBalance(emp, toDate);
};


const getEmployeeAdvanceTotalForPayroll = (emp, monthName) => {
  const { fromDate, toDate } =
    getPayrollCycleRangeForEmployee(emp, monthName);

  if (!fromDate || !toDate) return 0;

  return savedAdvanceBatches.reduce((total, batch) => {
    const batchDate = batch.advanceDate || "";

    if (batchDate < fromDate || batchDate > toDate) {
      return total;
    }

    const employeeAdvance = (batch.employees || [])
      .filter(
        (entry) =>
          String(entry.employeeId) === String(emp.id)
      )
      .reduce(
        (sum, entry) =>
          sum + Number(entry.advanceAmount || 0),
        0
      );

    return total + employeeAdvance;
  }, 0);
};

const getEmployeeAdvanceEntriesForPayroll = (emp, monthName) => {
  const { fromDate, toDate } =
    getPayrollCycleRangeForEmployee(emp, monthName);

  if (!fromDate || !toDate) return [];

  return savedAdvanceBatches
    .filter((batch) => {
      const batchDate = batch.advanceDate || "";

      return batchDate >= fromDate && batchDate <= toDate;
    })
    .flatMap((batch) =>
      (batch.employees || [])
        .filter(
          (entry) =>
            String(entry.employeeId) === String(emp.id)
        )
        .map((entry) => ({
          batchId: batch.id,
          advanceDate: batch.advanceDate,
          createdAt: batch.createdAt,
          advanceAmount: Number(entry.advanceAmount || 0),
          paymentMode: entry.paymentMode || "",
          remarks: entry.remarks || "",
        }))
    )
    .sort((a, b) =>
      String(a.advanceDate || "").localeCompare(
        String(b.advanceDate || "")
      )
    );
};



const getEmployeeAdvanceTotalBetweenDates = (
  emp,
  fromDate,
  toDate
) => {
  if (!fromDate || !toDate) return 0;

  return savedAdvanceBatches.reduce((total, batch) => {
    const batchDate = batch.advanceDate || "";

    if (batchDate < fromDate || batchDate > toDate) {
      return total;
    }

    const employeeAdvance = (batch.employees || [])
      .filter(
        (entry) =>
          String(entry.employeeId) === String(emp.id)
      )
      .reduce(
        (sum, entry) =>
          sum + Number(entry.advanceAmount || 0),
        0
      );

    return total + employeeAdvance;
  }, 0);
};

function getEmployeeHistoricalSalaryPaidForCycle(
  emp,
  fromDate,
  toDate
) {
  if (!emp || !fromDate || !toDate) return 0;

  return savedHistoricalSalaryPaymentBatches.reduce(
    (total, batch) => {
      const employeeSalaryPaid = (batch.payments || [])
        .filter(
          (payment) =>
            String(payment.employeeId) === String(emp.id) &&
            String(payment.salaryPeriodFrom || "") ===
              String(fromDate) &&
            String(payment.salaryPeriodTo || "") ===
              String(toDate)
        )
        .reduce(
          (sum, payment) =>
            sum + Number(payment.amount || 0),
          0
        );

      return total + employeeSalaryPaid;
    },
    0
  );
}

const getEmployeeCarryForwardBeforePayroll = (emp, monthName) => {
  const { fromDate } = getPayrollCycleRangeForEmployee(
    emp,
    monthName
  );

  if (!fromDate) return 0;

  let cursorToDate = new Date(`${fromDate}T00:00:00`);
  cursorToDate.setDate(cursorToDate.getDate() - 1);

  const previousCycles = [];

  // Check previous 24 payroll cycles for negative carry-forward.
  for (let i = 0; i < 24; i += 1) {
    const toDateKey = getLocalDateKey(cursorToDate);
    const cycleFromDate = getAdvanceCycleStartDate(emp, toDateKey);

    if (!cycleFromDate || cycleFromDate > toDateKey) {
      break;
    }

    previousCycles.push({
      fromDate: cycleFromDate,
      toDate: toDateKey,
    });

    const nextCursorDate = new Date(`${cycleFromDate}T00:00:00`);
    nextCursorDate.setDate(nextCursorDate.getDate() - 1);
    cursorToDate = nextCursorDate;
  }

  let carryForwardBalance = 0;

  previousCycles.reverse().forEach((cycle) => {
    const payableSummary = calculateAdvancePayableTillDate(
      emp,
      cycle.toDate
    );

    const cyclePayable = Number(
      payableSummary.payableAmount || 0
    );

    const cycleAdvance = getEmployeeAdvanceTotalBetweenDates(
  emp,
  cycle.fromDate,
  cycle.toDate
);

const historicalSalaryPaid =
  getEmployeeHistoricalSalaryPaidForCycle(
    emp,
    cycle.fromDate,
    cycle.toDate
  );

const cycleClosingBalance =
  cyclePayable +
  carryForwardBalance -
  cycleAdvance -
  historicalSalaryPaid;
    carryForwardBalance =
      cycleClosingBalance < 0 ? cycleClosingBalance : 0;
  });

  return carryForwardBalance;
};

const getEmployeeCarryForwardBeforeAdvanceDate = (
  emp,
  selectedDate = advanceDate
) => {
  const currentCycleStartDate = getAdvanceCycleStartDate(
    emp,
    selectedDate
  );

  if (!currentCycleStartDate) return 0;

  let cursorToDate = new Date(`${currentCycleStartDate}T00:00:00`);
  cursorToDate.setDate(cursorToDate.getDate() - 1);

  const previousCycles = [];

  // Check previous 24 payroll cycles for negative carry-forward.
  for (let i = 0; i < 24; i += 1) {
    const toDateKey = getLocalDateKey(cursorToDate);
    const cycleFromDate = getAdvanceCycleStartDate(emp, toDateKey);

    if (!cycleFromDate || cycleFromDate > toDateKey) {
      break;
    }

    previousCycles.push({
      fromDate: cycleFromDate,
      toDate: toDateKey,
    });

    const nextCursorDate = new Date(`${cycleFromDate}T00:00:00`);
    nextCursorDate.setDate(nextCursorDate.getDate() - 1);
    cursorToDate = nextCursorDate;
  }

  let carryForwardBalance = 0;

  previousCycles.reverse().forEach((cycle) => {
    const payableSummary = calculateAdvancePayableTillDate(
      emp,
      cycle.toDate
    );

    const cyclePayable = Number(
      payableSummary.payableAmount || 0
    );

    const cycleAdvance = getEmployeeAdvanceTotalBetweenDates(
  emp,
  cycle.fromDate,
  cycle.toDate
);

const historicalSalaryPaid =
  getEmployeeHistoricalSalaryPaidForCycle(
    emp,
    cycle.fromDate,
    cycle.toDate
  );

const cycleClosingBalance =
  cyclePayable +
  carryForwardBalance -
  cycleAdvance -
  historicalSalaryPaid;

    carryForwardBalance =
      cycleClosingBalance < 0 ? cycleClosingBalance : 0;
  });

  return carryForwardBalance;
};

const getEmployeeAdvanceTotalTillDate = (

  emp,
  selectedDate = advanceDate
) => {
  const fromDate = getAdvanceCycleStartDate(
    emp,
    selectedDate
  );

  if (!fromDate || !selectedDate) return 0;

  return savedAdvanceBatches.reduce((total, batch) => {
    const batchDate = batch.advanceDate || "";

    if (
      batchDate < fromDate ||
      batchDate > selectedDate
    ) {
      return total;
    }

    const employeeAdvance = (batch.employees || [])
      .filter(
        (entry) =>
          String(entry.employeeId) === String(emp.id)
      )
      .reduce(
        (sum, entry) =>
          sum + Number(entry.advanceAmount || 0),
        0
      );

    return total + employeeAdvance;
  }, 0);
};

const advanceEmployeeRows = useMemo(() => {
  if (!advanceDate) return [];

  return payrollEmployees
    .filter(
      (emp) =>
        (emp.status || "active") === "active" &&
        (advanceTab === "all" || emp.type === advanceTab) &&
        matchesAdvanceEmployeeSearch(emp)
    )
    .map((emp) => {
      const payableSummary = calculateAdvancePayableTillDate(
        emp,
        advanceDate
      );

     const previousAdvance =
  getEmployeeAdvanceTotalTillDate(emp, advanceDate);

const carryForwardBalance =
  getEmployeeCarryForwardBeforeAdvanceDate(emp, advanceDate);

const startingBalance = getEmployeeStartingPayableBalance(
  emp,
  advanceDate
);

const openingPayable = Number(
  startingBalance?.totalOpeningPayable || 0
);

const grossPayable = Number(payableSummary.payableAmount || 0);

const availableBalance =
  openingPayable +
  grossPayable +
  Number(carryForwardBalance || 0) -
  Number(previousAdvance || 0);

      return {
        emp,
        payableSummary,
        startingBalance,
        previousAdvance,
        carryForwardBalance,
        availableBalance,
      };
    });
}, [
  payrollEmployees,
  advanceTab,
  advanceEmployeeSearch,
  advanceDate,
  attendanceEntries,
  savedAdvanceBatches,
]);

const changePayrollEmployeeWeeklyOff = (


  employeeId,
  newWeeklyOff,
  effectiveFrom = getLocalDateKey()
) => {
  const updatedEmployees = payrollEmployees.map((emp) => {
    if (emp.id !== employeeId) return emp;

    const currentWeeklyOff = getEmployeeWeeklyOffForDate(emp, effectiveFrom);

    if (currentWeeklyOff === newWeeklyOff) {
      return emp;
    }

    const existingHistory = Array.isArray(emp.weekly_off_history)
      ? emp.weekly_off_history
      : [];

    const updatedHistory = [
      ...existingHistory.filter((item) => item.effective_from !== effectiveFrom),
      {
        weekly_off: newWeeklyOff,
        effective_from: effectiveFrom,
        changed_on: getLocalDateKey(),
      },
    ].sort((a, b) => a.effective_from.localeCompare(b.effective_from));

    return {
      ...emp,
      weekly_off: newWeeklyOff,
      weekly_off_history: updatedHistory,
    };
  });

  setPayrollEmployees(updatedEmployees);
  localStorage.setItem("hvf.payrollEmployees", JSON.stringify(updatedEmployees));
};


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
const [sanctionedRowsDB, setSanctionedRowsDB] = useState([]);
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

// ---- Separate dataset for the "Sanctioned View" (from Supabase; cross-device) ----
const sanctionedDetailedFiltered = useMemo(() => {
  // use the dedicated dataset we fetch in dbFetchSanctionedHVF
  const list = Array.isArray(sanctionedRowsDB) ? sanctionedRowsDB : [];

  // Sanctioned is HVF-only. "All" or "HVF Agency" show; other tabs -> empty.
  const byFirm =
    (savedFirmFilter === "All" || savedFirmFilter === "HVF Agency")
      ? list
      : [];

  // sort by sanctioned_date (desc), then created_at (desc)
  const sorted = [...byFirm].sort((a, b) => {
    const ta = a.sanctioned_date ? new Date(a.sanctioned_date).getTime() : 0;
    const tb = b.sanctioned_date ? new Date(b.sanctioned_date).getTime() : 0;
    if (tb !== ta) return tb - ta;
    const ca = a.created_at ? new Date(a.created_at).getTime() : 0;
    const cb = b.created_at ? new Date(b.created_at).getTime() : 0;
    return cb - ca;
  });

  // search (same as normal; items are already attached in the fetch)
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
}, [sanctionedRowsDB, savedFirmFilter, savedSearch]);

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

// (moved up) Sanctioned view loading flag — must be declared before first use
const [sanctionedLoading, setSanctionedLoading] = useState(false);
const emptyMsg =
  savedView === "sanctioned"
    ? (sanctionedLoading ? "" : "No sanctioned quotations found")
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
    // fetch delivered_on for these quotes and attach as delivered_date
    const ids = (data || []).map((q) => q.id);
let deliveredMap = {};

if (ids.length) {
  const allDeliveredRows = [];
  const batchSize = 50;

  for (let i = 0; i < ids.length; i += batchSize) {
    const batchIds = ids.slice(i, i + batchSize);

    const { data: dRows, error: dErr } = await supabase
      .from("delivered")
      .select("quote_id, delivered_on")
      .in("quote_id", batchIds);

    if (dErr) throw dErr;

    allDeliveredRows.push(...(dRows || []));
  }

  deliveredMap = allDeliveredRows.reduce((acc, r) => {
    acc[r.quote_id] = r.delivered_on || null;
    return acc;
  }, {});
}
    // build preview + attach delivered_date from deliveredMap
    const enriched = (data || []).map((q) => {
      const names = (q.quote_items || []).map((it) => it?.name || "");
      return {
        ...q,
        delivered_date: deliveredMap[q.id] || null,
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
    const dateISO = normalizeDate(deliverForm?.date);

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

try {
  if (typeof dbFetchSanctionedHVF === "function") await dbFetchSanctionedHVF();
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

// --------------------------------------------------
// ADAPTIVE ONE-PAGE QUOTATION SCALE
// --------------------------------------------------
// Normal quotations remain at 100%.
// Longer quotations progressively reduce the entire
// quotation layout only when necessary.
let quotationScale = 1;

if (firm === "HVF Agency") {
  // Approximate the vertical space needed by each item.
  // Items with specifications need slightly more height.
  const estimatedTableHeight =
    28 +
    cartList.reduce((total, item) => {
      const hasSpecs =
        String(item?.specs || "").trim().length > 0;

      return total + (hasSpecs ? 37 : 27);
    }, 0);

  // Normal HVF header/table starting area is roughly here.
  const estimatedHeaderHeight = 205;

  // Space required after the table:
  // total + terms + signature + bank details + bottom margin.
  const estimatedFooterHeight = 220;

  const estimatedTotalHeight =
    estimatedHeaderHeight +
    estimatedTableHeight +
    estimatedFooterHeight;

  // Keep a real bottom safety margin instead of allowing
  // bank details to touch the edge of the page.
  const usablePageHeight = ph - 34;

  if (estimatedTotalHeight > usablePageHeight) {
    quotationScale =
      usablePageHeight / estimatedTotalHeight;

    // Do not make a quotation unreadably tiny.
    quotationScale = Math.max(
      0.72,
      Math.min(1, quotationScale)
    );
  }
}

// Convenient scaler used throughout the HVF PDF layout.
const qs = (value) =>
  firm === "HVF Agency"
    ? value * quotationScale
    : value;

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

      // Downscale the source logo before embedding it in the PDF.
      // This keeps the same visible size while avoiding a huge
      // full-resolution PNG inside every quotation PDF.
      const logoCanvas = document.createElement("canvas");
      const targetWidth = 600;
      const targetHeight = Math.max(
        1,
        Math.round((img.height * targetWidth) / img.width)
      );

      logoCanvas.width = targetWidth;
      logoCanvas.height = targetHeight;

      const logoCtx = logoCanvas.getContext("2d");

      // White background lets us use JPEG without transparency
      // and keeps the PDF dramatically smaller.
      logoCtx.fillStyle = "#ffffff";
      logoCtx.fillRect(0, 0, targetWidth, targetHeight);

      logoCtx.drawImage(
        img,
        0,
        0,
        targetWidth,
        targetHeight
      );

      const compressedLogo = logoCanvas.toDataURL(
        "image/jpeg",
        0.82
      );

      doc.addImage(
        compressedLogo,
        "JPEG",
        x,
        y,
        w,
        h,
        undefined,
        "FAST"
      );

      logoBottom = y + h;
    } catch {}

        doc.setFont("helvetica", "bold");
    doc.setFontSize(qs(16));
    doc.text(
      "QUOTATION",
      pw / 2,
      logoBottom + qs(28),
      { align: "center" }
    );

    doc.setFont("helvetica", "normal");
    doc.setFontSize(qs(10));

    // Left block (To)
    let y0 = logoBottom + qs(40);

    doc.setFontSize(qs(11));
    doc.text("To,", L, y0);
    y0 += qs(18);

    doc.setFont("helvetica", "bold");
    doc.text(
      String(qHeader.customer_name || ""),
      L,
      y0
    );
    y0 += qs(16);

    doc.text(
      String(qHeader.address || ""),
      L,
      y0
    );
    y0 += qs(16);

    doc.text(
      String(qHeader.phone || ""),
      L,
      y0
    );

    // Right meta
    doc.setFont("helvetica", "normal");
    doc.setFontSize(qs(10));

    doc.text(
      `Ref: ${number}`,
      R,
      logoBottom + qs(40),
      { align: "right" }
    );

    doc.text(
      `Date: ${dateStr}`,
      R,
      logoBottom + qs(55),
      { align: "right" }
    );

    // Intro
    const introY = y0 + qs(28);

    doc.setFontSize(qs(11));
    doc.text("Dear Sir/Madam,", L, introY);

    doc.text(
      "With reference to your enquiry we are pleased to offer you as under:",
      L,
      introY + qs(16)
    );

    afterHeaderY = introY + qs(38);

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
  fontSize:
    firm === "HVF Agency"
      ? qs(10)
      : 10,
  cellPadding:
    firm === "HVF Agency"
      ? qs(6)
      : 6,
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
  fontSize:
    firm === "HVF Agency"
      ? qs(10)
      : 10,
  cellPadding:
    firm === "HVF Agency"
      ? qs(6)
      : 6,
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
let totalsY =
  (at?.finalY ?? afterHeaderY) +
  (firm === "HVF Agency" ? qs(18) : 18);

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
      doc.setFontSize(
  firm === "HVF Agency" ? qs(12) : 12
);
      const RUPEE = String.fromCharCode(0x20b9);
      doc.text(`Total: ${RUPEE} ${inr(cartSubtotal)}`, totalsRightX, totalsY, {
        align: "right",
      });
    } catch {
      doc.setFont("helvetica", "bold");
      doc.setFontSize(
  firm === "HVF Agency" ? qs(12) : 12
);
      doc.text(`Total: Rs ${inr(cartSubtotal)}`, totalsRightX, totalsY, {
        align: "right",
      });
    }
  }

  // -------------------------------
// TERMS & BANK (HVF min anchor at ~60% page height)
// -------------------------------
let ty =
  totalsY +
  (firm === "HVF Agency" ? qs(28) : 28);

// Keep the old 60% visual anchor only when
// the quotation does not need adaptive shrinking.
if (
  firm === "HVF Agency" &&
  quotationScale === 1
) {
  const minTermsTop = Math.round(ph * 0.60);

  if (ty < minTermsTop) {
    ty = minTermsTop;
  }
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
    doc.setFontSize(
  firm === "HVF Agency" ? qs(11) : 11
);
    doc.text("Terms & Conditions:", L, ty, { underline: true });

    doc.setFont(tableFontLocal, "normal");
    doc.setFontSize(
  firm === "HVF Agency" ? qs(10) : 10
);
    doc.text(
      [
        "This quotation is valid for one month from the date of issue.",
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
      ty + (firm === "HVF Agency" ? qs(16) : 16)
    );

    doc.setFont(tableFontLocal, "bold");
    doc.text(
  "BANK DETAILS",
  L,
  ty + (firm === "HVF Agency" ? qs(120) : 120)
);

    doc.setFont(tableFontLocal, "normal");
    let bankLines = [];
    if (firm === "HVF Agency") {
      bankLines = [
        "HVF AGENCY",
        "ICICI BANK (Moran Branch)",
        "A/C No - 199505500412",
        "IFSC Code - ICIC0001995",
"Email: hvfagency123@gmail.com",
      ];
    } else {
      bankLines = [
        "AC No. 11010061051",
        "IFSC Cord - SBIN0007368",
        "Branch - Moran Branch",
      ];
    }
    doc.text(
  bankLines,
  L,
  ty + (firm === "HVF Agency" ? qs(136) : 136)
);
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
// Sanctioned View: clear legacy local keys so no rows get hidden by stale filters
function resetSanctionedLocal() {
  try { localStorage.removeItem("hvf.delivered"); } catch {}
  try { localStorage.removeItem("hvf_delivered"); } catch {}
  try { localStorage.removeItem("hvf.deliveredIds"); } catch {}
  try { localStorage.removeItem("hvf.recycle"); } catch {}
  try { localStorage.removeItem("hvf.recycleBin"); } catch {}
  try { localStorage.setItem("hvf.savedSearch", ""); } catch {}
  try { localStorage.setItem("hvf.savedFirm", "HVF Agency"); } catch {}
}

// ---- Cache versioning: purge stale local keys once per version bump ----
const HVF_CACHE_VERSION = "2025-11-22-1"; // bump when storage schema/keys change
const HVF_CACHE_KEYS = [
  "hvf.delivered",
  "hvf_delivered",
  "hvf.deliveredIds",
  "hvf.recycle",
  "hvf.recycleBin",
  "hvf.savedSearch",
  "hvf.savedFirm"
];

function ensureCacheVersion() {
  try {
    const cur = localStorage.getItem("hvf.cacheVersion");
    if (cur !== HVF_CACHE_VERSION) {
      HVF_CACHE_KEYS.forEach((k) => { try { localStorage.removeItem(k); } catch {} });
      localStorage.setItem("hvf.cacheVersion", HVF_CACHE_VERSION);
    }
  } catch {}
}
// Run version check once on load
useEffect(() => {
  ensureCacheVersion();
}, []);

// ---- Sanctioned (HVF-only) fetch from Supabase (cross-device) ----
async function dbFetchSanctionedHVF() {
  // make sure the loading flag goes on now and off in finally
  try { setSanctionedLoading(true); } catch {}

  // one-run function so we can retry on Safari's "Load failed"
  const run = async () => {
    // 1) Pull ALL HVF quotes
    const { data: qRows, error: qErr } = await supabase
      .from("quotes")
      .select(
        "id, number, firm, customer_name, phone, subject, address, total, created_at, sanctioned_status, sanctioned_mode, sanctioned_date, sanctioned_amount, csm_amount, rtnad_amount"
      )
      .eq("firm", "HVF Agency")
      .order("created_at", { ascending: false });
    if (qErr) throw qErr;

    // 2) Exclude already-delivered quotes
    const { data: dRows, error: dErr } = await supabase
      .from("delivered")
      .select("quote_id");
    if (dErr) throw dErr;
    const deliveredIds = new Set((dRows || []).map((r) => r.quote_id));

    // 3) Detect “sanctioned” client-side (any signal)
    const base = (qRows || []).filter((q) => {
      if (deliveredIds.has(q.id)) return false;
      const hasStatus = q.sanctioned_status != null && String(q.sanctioned_status).trim() !== "";
      const hasMode   = q.sanctioned_mode   != null && String(q.sanctioned_mode).trim() !== "";
      const hasAmt    = q.sanctioned_amount != null && String(q.sanctioned_amount).trim() !== "";
      const hasDate   = q.sanctioned_date   != null && String(q.sanctioned_date).trim() !== "";
      return hasStatus || hasMode || hasAmt || hasDate;
    });

    // 4) Items for the “Items (first 2–3)” column
    const ids = base.map((q) => q.id);
    let itemsByQuote = {};
    if (ids.length) {
      const { data: iRows, error: iErr } = await supabase
        .from("quote_items")
        .select("quote_id, name")
        .in("quote_id", ids);
      if (iErr) throw iErr;
      itemsByQuote = (iRows || []).reduce((acc, it) => {
        (acc[it.quote_id] ||= []).push({ name: it.name || "" });
        return acc;
      }, {});
    }

    // 5) Merge + sort by sanctioned_date desc, then created_at desc
    const rows = base
      .map((q) => ({ ...q, quote_items: itemsByQuote[q.id] || [] }))
      .sort((a, b) => {
        const ta = a.sanctioned_date ? new Date(a.sanctioned_date).getTime() : 0;
        const tb = b.sanctioned_date ? new Date(b.sanctioned_date).getTime() : 0;
        if (tb !== ta) return tb - ta;
        const ca = a.created_at ? new Date(a.created_at).getTime() : 0;
        const cb = b.created_at ? new Date(b.created_at).getTime() : 0;
        return cb - ca;
      });

    // 6) Save to state; clear filters that could hide rows
    try { setSanctionedRowsDB(rows); } catch {}
    if (typeof setTableData !== "undefined") { try { setTableData(rows); } catch {} }
    if (typeof setSavedSearch !== "undefined") { try { setSavedSearch(""); } catch {} }
    try { localStorage.setItem("hvf.savedSearch", ""); } catch {}
    if (typeof setSavedFirm !== "undefined")  { try { setSavedFirm("HVF Agency"); } catch {} }
    try { localStorage.setItem("hvf.savedFirm", "HVF Agency"); } catch {}
    if (typeof setSavedCount !== "undefined") { try { setSavedCount(rows.length); } catch {} }
  };

  try {
    await run();
  } catch (e) {
    const msg = String(e?.message || e);
    console.error("dbFetchSanctionedHVF:", msg);
    // Safari sometimes flaps; retry once
    if (
      msg.includes("Load failed") ||
      msg.includes("Failed to fetch") ||
      msg.includes("network connection was lost")
    ) {
      try {
        await new Promise((r) => setTimeout(r, 350));
        await run();
      } catch (e2) {
        console.error("dbFetchSanctionedHVF retry failed:", e2?.message || e2);
      }
    }
    // keep whatever is currently shown on failure
  } finally {
    try { setSanctionedLoading(false); } catch {}
  }
}

// Auto-load HVF sanctioned list when Sanctioned View is active (reset stale local filters)
useEffect(() => {
  if (savedView === "sanctioned") {
    resetSanctionedLocal();
    if (typeof setSavedSearch !== "undefined") { try { setSavedSearch(""); } catch {} }
    if (typeof setSavedFirm !== "undefined")  { try { setSavedFirm("HVF Agency"); } catch {} }
    dbFetchSanctionedHVF();
  }
}, [savedView]);

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
        .select("id, number, firm, customer_name, phone, address, total")
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
address: q.address || "",
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
// --- helper: return YYYY-MM-DD from DD/MM/YYYY or other inputs ---
function normalizeDate(input) {
  try {
    if (!input) return new Date().toISOString().slice(0, 10);
    const s = String(input).trim();

    // dd/mm/yyyy -> yyyy-mm-dd
    const dmy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (dmy) {
      const dd = dmy[1].padStart(2, "0");
      const mm = dmy[2].padStart(2, "0");
      const yyyy = dmy[3];
      return `${yyyy}-${mm}-${dd}`;
    }

    // already yyyy-mm-dd
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

    // ISO strings yyyy-mm-ddTHH:MM:SSZ
    if (s.includes("T")) return s.slice(0, 10);

    // last resort: Date parse
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);

    return new Date().toISOString().slice(0, 10);
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

async function dbUpsertDelivered(quoteId, payload) {
  // snapshot BEFORE writing delivered record (for global Undo)
  takeSnapshot(`deliver:${quoteId || (payload && payload.quote_id) || ""}`);
  const rec = {
    quote_id: quoteId,
    delivered_on: normalizeDate(payload?.date),
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

{isAdmin && (
  <button
    type="button"
    className="btn"
    onClick={() => setShowCatalogExportPanel((v) => !v)}
    style={{ marginLeft: 8, marginTop: 6 }}
  >
    📄 Export Catalog
  </button>
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

{page === "catalog" && isAdmin && showCatalogExportPanel && ( 
 <div className="paper section" style={{ maxWidth: 1100, margin: "0 auto 16px" }}>
    <h3 style={{ marginBottom: 10 }}>📄 Export Catalog</h3>

    <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
      <select
        value={catalogExportMode}
        onChange={(e) => setCatalogExportMode(e.target.value)}
      >
        <option value="PRICE">Price List</option>
        <option value="DISPLAY">Display Catalog</option>
      </select>

      <select
        value={catalogExportCategories[0]}
        onChange={(e) => setCatalogExportCategories([e.target.value])}
      >
        <option value="ALL">All Categories</option>
        {categories.map((c) => (
          <option key={c} value={c}>{c}</option>
        ))}
      </select>

      <label>
        <input
          type="checkbox"
          checked={catalogIncludeSelling}
          onChange={(e) => setCatalogIncludeSelling(e.target.checked)}
        />
        Selling Price
      </label>

      <label>
        <input
          type="checkbox"
          checked={catalogIncludeCost}
          onChange={(e) => setCatalogIncludeCost(e.target.checked)}
        />
        Cost Price
      </label>

      <button
  className="btn primary"
  type="button"
  onClick={exportCatalogPdf}
>
  Export PDF
</button>
    </div>
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
                required={!editingProductId}
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
{isAdmin && editingProductId && (
  <details className="paper section" style={{ maxWidth: 1100, margin: "0 auto 16px" }} open>
    <summary className="btn" style={{ cursor: "pointer", background: "#fff3cd" }}>
      ✏️ Edit Product
    </summary>

    <div style={{ padding: 12 }}>
<form onSubmit={onEditSave} style={{ marginTop: 12 }}>
  <div className="addform-grid" style={{ display: "grid", gap: 10, alignItems: "end" }}>
    <label>
      <div style={{ fontSize: 12, color: "#666" }}>Name *</div>
      <input
        name="name"
        value={editForm.name}
        onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
        required
      />
    </label>

    <label>
      <div style={{ fontSize: 12, color: "#666" }}>Category *</div>
      <select
        name="category"
        value={editForm.category}
        onChange={(e) => setEditForm((f) => ({ ...f, category: e.target.value }))}
        required
      >
        <option value="">Select category</option>
        {categories.map((c) => (
          <option key={c} value={c}>{c}</option>
        ))}
      </select>
    </label>

    <label>
      <div style={{ fontSize: 12, color: "#666" }}>MRP (₹) *</div>
      <input
        type="number"
        name="mrp"
        value={editForm.mrp}
        onChange={(e) => setEditForm((f) => ({ ...f, mrp: e.target.value }))}
        min="0"
        required
      />
    </label>

    <label>
      <div style={{ fontSize: 12, color: "#666" }}>Selling Price (₹)</div>
      <input
        type="number"
        name="sell_price"
        value={editForm.sell_price}
        onChange={(e) => setEditForm((f) => ({ ...f, sell_price: e.target.value }))}
        min="0"
      />
    </label>

    <label>
      <div style={{ fontSize: 12, color: "#666" }}>Cost Price (₹)</div>
      <input
        type="number"
        name="cost_price"
        value={editForm.cost_price}
        onChange={(e) => setEditForm((f) => ({ ...f, cost_price: e.target.value }))}
        min="0"
      />
    </label>

    <label>
      <div style={{ fontSize: 12, color: "#666" }}>Replace Image</div>
      <input
        type="file"
        accept="image/*"
        onChange={(e) =>
          setEditForm((f) => ({
            ...f,
            imageFile: e.target.files?.[0] || null,
          }))
        }
      />
    </label>

    <label style={{ gridColumn: "1 / -1" }}>
      <div style={{ fontSize: 12, color: "#666" }}>Specs / description</div>
      <input
        name="specs"
        value={editForm.specs}
        onChange={(e) => setEditForm((f) => ({ ...f, specs: e.target.value }))}
        placeholder="Short specs shown on card"
      />
    </label>

    <div style={{ gridColumn: "1 / -1", textAlign: "left", display: "flex", gap: 8 }}>
      <button type="submit" className="btn primary" disabled={saving}>
        {saving ? "Updating..." : "Update Product"}
      </button>

      <button
        type="button"
        className="btn"
        onClick={() => {
          setEditingProductId(null);
          setEditingImageUrl("");
          setEditForm({
            name: "",
            category: "",
            mrp: "",
            sell_price: "",
            cost_price: "",
            specs: "",
            imageFile: null,
          });
        }}
      >
        Cancel Edit
      </button>
<button
  type="button"
  className="btn"
  disabled={saving}
  onClick={onDeleteProduct}
  style={{
    background: "#dc2626",
    color: "#fff",
    borderColor: "#dc2626",
  }}
>
  Delete Product
</button>
    </div>
  </div>
</form>
    </div>
  </details>
)}
  </>
)}

{page === "startingPayableBalance" && (
  <div
    style={{
      maxWidth: 1160,
      margin: "0 auto 40px",
      padding: "0 12px",
    }}
  >
    <div className="paper section" style={{ padding: 20 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 12,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <div>
          <h1 style={{ margin: 0 }}>Starting Payable Balance</h1>
          <p style={{ color: "#666", marginTop: 6 }}>
            Enter opening salary, bonus, advance, and carry-forward values
            from the manual register before using app-based payroll.
          </p>
        </div>

        <button
          type="button"
          className="btn"
          onClick={() => setPage("attendance")}
        >
          Back to Attendance
        </button>
      </div>

      <div
        style={{
          marginTop: 18,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 12,
        }}
      >
        <label>
          <div style={{ fontSize: 12, color: "#666", marginBottom: 4 }}>
            Employee Type
          </div>
          <select
            value={startingBalanceType}
            onChange={(e) => {
              setStartingBalanceType(e.target.value);
              setStartingBalanceDraftEntries({});
              setGeneratedStartingPayableSummary(null);
            }}
            style={{
              width: "100%",
              padding: "10px 12px",
              border: "1px solid #d1d5db",
              borderRadius: 8,
            }}
          >
            <option value="non_contractual">Non-contractual</option>
            <option value="contractual">Contractual</option>
          </select>
        </label>

        <label>
          <div style={{ fontSize: 12, color: "#666", marginBottom: 4 }}>
            Starting Balance Date
          </div>
          <input
            type="date"
            value={startingBalanceDate}
            onChange={(e) => {
              setStartingBalanceDate(e.target.value);
              setGeneratedStartingPayableSummary(null);
            }}
            style={{
              width: "100%",
              padding: "10px 12px",
              border: "1px solid #d1d5db",
              borderRadius: 8,
            }}
          />
        </label>

        <label>
          <div style={{ fontSize: 12, color: "#666", marginBottom: 4 }}>
            Manual Register Covered Till
          </div>
          <input
            type="date"
            value={startingBalanceCoveredTillDate}
            onChange={(e) => {
              setStartingBalanceCoveredTillDate(e.target.value);
              setGeneratedStartingPayableSummary(null);
            }}
            style={{
              width: "100%",
              padding: "10px 12px",
              border: "1px solid #d1d5db",
              borderRadius: 8,
            }}
          />
        </label>
      </div>

      {startingBalanceType === "contractual" && (
        <div
          style={{
            marginTop: 14,
            padding: "10px 12px",
            borderRadius: 8,
            background: "#fffbeb",
            border: "1px solid #fde68a",
            color: "#b45309",
            fontSize: 13,
            fontWeight: 700,
            lineHeight: 1.4,
          }}
        >
          Contractual starting balance can be entered later after contractual
          payroll rules are finalized.
        </div>
      )}

      <div style={{ marginTop: 18, overflowX: "auto" }}>
        <table
          key={JSON.stringify(startingBalanceDraftEntries)}
          style={{
            width: "100%",
            borderCollapse: "collapse",
            minWidth: 1050,
            fontSize: 13,
          }}
        >
          <thead>
            <tr style={{ background: "#f3f4f6" }}>
              <th style={{ padding: 10, textAlign: "left" }}>Employee</th>
              <th style={{ padding: 10, textAlign: "left" }}>Branch</th>
              <th style={{ padding: 10, textAlign: "right" }}>
                Opening Salary Payable
              </th>
              <th style={{ padding: 10, textAlign: "right" }}>
                Opening Bonus Payable
              </th>
              <th style={{ padding: 10, textAlign: "right" }}>
                Manual Advance Paid
              </th>
              <th style={{ padding: 10, textAlign: "right" }}>
                Carry Forward
              </th>
              <th style={{ padding: 10, textAlign: "right" }}>
                Bonus Carry-in Days
              </th>
              <th style={{ padding: 10, textAlign: "left" }}>Remarks</th>
            </tr>
          </thead>

          <tbody>
            {payrollEmployees
              .filter(
                (emp) =>
                  (emp.status || "active") === "active" &&
                  emp.type === startingBalanceType
              )
              .map((emp) => {
                const entry =
                  startingBalanceDraftEntries[emp.id] || {};

                const updateStartingBalanceEntry = (field, value) => {
                  setStartingBalanceDraftEntries((previous) => ({
                    ...previous,
                    [emp.id]: {
                      ...(previous[emp.id] || {}),
                      [field]: value,
                    },
                  }));
                  setGeneratedStartingPayableSummary(null);
                };

                return (
                  <tr key={emp.id} style={{ borderTop: "1px solid #e5e7eb" }}>
                    <td style={{ padding: 10 }}>
                      <div style={{ fontWeight: 800 }}>
                        {emp.name}
                      </div>
                      <div style={{ fontSize: 11, color: "#6b7280" }}>
                        ID: {emp.id}
                      </div>
                    </td>

                    <td style={{ padding: 10, color: "#374151" }}>
                      {emp.branch || "—"}
                    </td>

                    <td style={{ padding: 10, textAlign: "right" }}>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        defaultValue={entry.openingSalaryPayable || ""}
                        onBlur={(e) =>
                          updateStartingBalanceEntry(
                            "openingSalaryPayable",
                            e.target.value
                          )
                        }
                        style={{
                          width: 120,
                          padding: "8px 10px",
                          border: "1px solid #d1d5db",
                          borderRadius: 8,
                          textAlign: "right",
                          fontWeight: 700,
                        }}
                      />
                    </td>

                    <td style={{ padding: 10, textAlign: "right" }}>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        defaultValue={entry.openingBonusPayable || ""}
                        onBlur={(e) =>
                          updateStartingBalanceEntry(
                            "openingBonusPayable",
                            e.target.value
                          )
                        }
                        style={{
                          width: 120,
                          padding: "8px 10px",
                          border: "1px solid #d1d5db",
                          borderRadius: 8,
                          textAlign: "right",
                          fontWeight: 700,
                        }}
                      />
                    </td>

                    <td style={{ padding: 10, textAlign: "right" }}>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        defaultValue={entry.manualAdvancePaid || ""}
                        onBlur={(e) =>
                          updateStartingBalanceEntry(
                            "manualAdvancePaid",
                            e.target.value
                          )
                        }
                        style={{
                          width: 120,
                          padding: "8px 10px",
                          border: "1px solid #d1d5db",
                          borderRadius: 8,
                          textAlign: "right",
                          fontWeight: 700,
                        }}
                      />
                    </td>

                    <td style={{ padding: 10, textAlign: "right" }}>
                      <input
                        type="number"
                        step="1"
                        defaultValue={entry.openingCarryForward || ""}
                        onBlur={(e) =>
                          updateStartingBalanceEntry(
                            "openingCarryForward",
                            e.target.value
                          )
                        }
                        placeholder="0 or - amount"
                        style={{
                          width: 120,
                          padding: "8px 10px",
                          border: "1px solid #d1d5db",
                          borderRadius: 8,
                          textAlign: "right",
                          fontWeight: 700,
                        }}
                      />
                    </td>

                    <td style={{ padding: 10, textAlign: "right" }}>
                      <input
                        type="number"
                        min="0"
                        max="6"
                        step="1"
                        defaultValue={entry.bonusCarryInDays || ""}
                        onBlur={(e) =>
                          updateStartingBalanceEntry(
                            "bonusCarryInDays",
                            e.target.value
                          )
                        }
                        style={{
                          width: 90,
                          padding: "8px 10px",
                          border: "1px solid #d1d5db",
                          borderRadius: 8,
                          textAlign: "right",
                          fontWeight: 700,
                        }}
                      />
                    </td>

                    <td style={{ padding: 10 }}>
                      <input
                        type="text"
                        defaultValue={entry.remarks || ""}
                        onBlur={(e) =>
                          updateStartingBalanceEntry(
                            "remarks",
                            e.target.value
                          )
                        }
                        placeholder="Optional"
                        style={{
                          width: 180,
                          padding: "8px 10px",
                          border: "1px solid #d1d5db",
                          borderRadius: 8,
                        }}
                      />
                    </td>
                  </tr>
                );
              })}

            {payrollEmployees.filter(
              (emp) =>
                (emp.status || "active") === "active" &&
                emp.type === startingBalanceType
            ).length === 0 && (
              <tr>
                <td
                  colSpan={8}
                  style={{
                    padding: 18,
                    textAlign: "center",
                    color: "#6b7280",
                  }}
                >
                  No active employees found for this type.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div
        style={{
          marginTop: 14,
          padding: "10px 12px",
          borderRadius: 8,
          background: "#f8fafc",
          border: "1px solid #e5e7eb",
          color: "#4b5563",
          fontSize: 12,
          lineHeight: 1.6,
        }}
      >
        <b>Carry Forward:</b> Can be negative if the employee already has
        excess advance. Example: enter -500 if ₹500 should be recovered later.
        <br />
        <b>Bonus Carry-in Days:</b> Enter the number of continuous present/PH
        working days from the old manual register that should continue into
        the app for weekly bonus calculation. Example: if 4 old working days
        were already present before app attendance starts, enter 4.
      </div>

      <div
        style={{
          marginTop: 18,
          display: "flex",
          justifyContent: "flex-end",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        <button
          type="button"
          className="btn"
          onClick={() => {
            setStartingBalanceDraftEntries({});
            setGeneratedStartingPayableSummary(null);
          }}
        >
          Clear Entries
        </button>

        <button
          type="button"
          className="btn primary"
          onClick={() => {
            if (!startingBalanceDate) {
              alert("Please select Starting Balance Date.");
              return;
            }

            if (!startingBalanceCoveredTillDate) {
              alert("Please select Manual Register Covered Till date.");
              return;
            }

            if (startingBalanceType === "contractual") {
              alert(
                "Contractual starting balance will be finalized later after contractual payroll rules are confirmed."
              );
              return;
            }

            const employeeRows = payrollEmployees.filter(
              (emp) =>
                (emp.status || "active") === "active" &&
                emp.type === startingBalanceType
            );

            const entries = employeeRows
              .map((emp) => {
                const draft =
                  startingBalanceDraftEntries[emp.id] || {};

                const openingSalaryPayable = Number(
                  draft.openingSalaryPayable || 0
                );
                const openingBonusPayable = Number(
                  draft.openingBonusPayable || 0
                );
                const manualAdvancePaid = Number(
                  draft.manualAdvancePaid || 0
                );
                const openingCarryForward = Number(
                  draft.openingCarryForward || 0
                );
                const bonusCarryInDays = Number(
                  draft.bonusCarryInDays || 0
                );

                const remarks = String(draft.remarks || "").trim();

                const hasEntry =
                  openingSalaryPayable !== 0 ||
                  openingBonusPayable !== 0 ||
                  manualAdvancePaid !== 0 ||
                  openingCarryForward !== 0 ||
                  bonusCarryInDays !== 0 ||
                  remarks;

                if (!hasEntry) return null;

                const totalOpeningPayable =
                  openingSalaryPayable +
                  openingBonusPayable -
                  manualAdvancePaid +
                  openingCarryForward;

                return {
                  employeeId: emp.id,
                  employeeName: emp.name,
                  employeeType: emp.type,
                  branch: emp.branch || "",
                  openingSalaryPayable,
                  openingBonusPayable,
                  manualAdvancePaid,
                  openingCarryForward,
                  bonusCarryInDays,
                  totalOpeningPayable,
                  remarks,
                };
              })
              .filter(Boolean);

            if (entries.length === 0) {
              alert("Please enter starting balance for at least one employee.");
              return;
            }

            const totalSalary = entries.reduce(
              (sum, entry) =>
                sum + Number(entry.openingSalaryPayable || 0),
              0
            );

            const totalBonus = entries.reduce(
              (sum, entry) =>
                sum + Number(entry.openingBonusPayable || 0),
              0
            );

            const totalManualAdvance = entries.reduce(
              (sum, entry) =>
                sum + Number(entry.manualAdvancePaid || 0),
              0
            );

            const totalCarryForward = entries.reduce(
              (sum, entry) =>
                sum + Number(entry.openingCarryForward || 0),
              0
            );

            const finalOpeningBalance = entries.reduce(
              (sum, entry) =>
                sum + Number(entry.totalOpeningPayable || 0),
              0
            );

            const confirmSave = window.confirm(
              `Confirm Starting Payable Balance?\n\nType: ${
                startingBalanceType === "non_contractual"
                  ? "Non-contractual"
                  : "Contractual"
              }\nStarting Date: ${
                startingBalanceDate
                  ? startingBalanceDate.split("-").reverse().join("-")
                  : "—"
              }\nManual Register Covered Till: ${
                startingBalanceCoveredTillDate
                  ? startingBalanceCoveredTillDate
                      .split("-")
                      .reverse()
                      .join("-")
                  : "—"
              }\nEmployees: ${entries.length}\n\nOpening Salary: ₹${Math.round(
                totalSalary
              ).toLocaleString("en-IN")}\nOpening Bonus: ₹${Math.round(
                totalBonus
              ).toLocaleString("en-IN")}\nManual Advance Paid: ₹${Math.round(
                totalManualAdvance
              ).toLocaleString("en-IN")}\nCarry Forward: ${
                totalCarryForward < 0 ? "−" : ""
              }₹${Math.abs(Math.round(totalCarryForward)).toLocaleString(
                "en-IN"
              )}\n\nFinal Opening Balance: ${
                finalOpeningBalance < 0 ? "−" : ""
              }₹${Math.abs(Math.round(finalOpeningBalance)).toLocaleString(
                "en-IN"
              )}\n\nClick OK to save.`
            );

            if (!confirmSave) return;

            const newStartingBalance = {
              id: `SPB-${Date.now()}`,
              type: startingBalanceType,
              startingBalanceDate,
              coveredTillDate: startingBalanceCoveredTillDate,
              createdAt: new Date().toISOString(),
              entries,
              totalSalary,
              totalBonus,
              totalManualAdvance,
              totalCarryForward,
              finalOpeningBalance,
            };

            setSavedStartingPayableBalances((previous) => [
              newStartingBalance,
              ...previous,
            ]);

setGeneratedStartingPayableSummary(newStartingBalance);
setStartingBalanceDraftEntries({});

alert("Starting Payable Balance saved successfully.");
          }}
        >
          Generate & Save Starting Balance
        </button>
      </div>

      {generatedStartingPayableSummary && (
        <div
          className="paper section"
          style={{
            marginTop: 20,
            padding: 16,
            border: "1px solid #bfdbfe",
            background: "#f8fbff",
          }}
        >
          <h3 style={{ margin: 0 }}>
            Saved Starting Payable Balance Summary
          </h3>

          <div
            style={{
              marginTop: 8,
              color: "#4b5563",
              fontSize: 13,
              lineHeight: 1.5,
            }}
          >
            <b>Reference:</b> {generatedStartingPayableSummary.id}
            {"  "}•{"  "}
            <b>Type:</b>{" "}
            {generatedStartingPayableSummary.type === "non_contractual"
              ? "Non-contractual"
              : "Contractual"}
            {"  "}•{"  "}
            <b>Starting Date:</b>{" "}
            {generatedStartingPayableSummary.startingBalanceDate
              ? generatedStartingPayableSummary.startingBalanceDate
                  .split("-")
                  .reverse()
                  .join("-")
              : "—"}
            {"  "}•{"  "}
            <b>Manual Covered Till:</b>{" "}
            {generatedStartingPayableSummary.coveredTillDate
              ? generatedStartingPayableSummary.coveredTillDate
                  .split("-")
                  .reverse()
                  .join("-")
              : "—"}
          </div>

          <div
            style={{
              marginTop: 14,
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: 10,
            }}
          >
            <div className="paper section" style={{ padding: 12 }}>
              <div style={{ fontSize: 12, color: "#666" }}>
                Opening Salary
              </div>
              <div style={{ fontSize: 20, fontWeight: 900 }}>
                ₹
                {Math.round(
                  generatedStartingPayableSummary.totalSalary || 0
                ).toLocaleString("en-IN")}
              </div>
            </div>

            <div className="paper section" style={{ padding: 12 }}>
              <div style={{ fontSize: 12, color: "#666" }}>
                Opening Bonus
              </div>
              <div style={{ fontSize: 20, fontWeight: 900 }}>
                ₹
                {Math.round(
                  generatedStartingPayableSummary.totalBonus || 0
                ).toLocaleString("en-IN")}
              </div>
            </div>

            <div className="paper section" style={{ padding: 12 }}>
              <div style={{ fontSize: 12, color: "#666" }}>
                Manual Advance Paid
              </div>
              <div
                style={{
                  fontSize: 20,
                  fontWeight: 900,
                  color: "#dc2626",
                }}
              >
                ₹
                {Math.round(
                  generatedStartingPayableSummary.totalManualAdvance || 0
                ).toLocaleString("en-IN")}
              </div>
            </div>

            <div className="paper section" style={{ padding: 12 }}>
              <div style={{ fontSize: 12, color: "#666" }}>
                Final Opening Balance
              </div>
              <div
                style={{
                  fontSize: 20,
                  fontWeight: 900,
                  color:
                    Number(
                      generatedStartingPayableSummary.finalOpeningBalance || 0
                    ) < 0
                      ? "#dc2626"
                      : "#166534",
                }}
              >
                {Number(
                  generatedStartingPayableSummary.finalOpeningBalance || 0
                ) < 0
                  ? "−"
                  : ""}
                ₹
                {Math.abs(
                  Math.round(
                    generatedStartingPayableSummary.finalOpeningBalance || 0
                  )
                ).toLocaleString("en-IN")}
              </div>
            </div>
          </div>

          <div style={{ marginTop: 14, overflowX: "auto" }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                minWidth: 900,
                fontSize: 13,
              }}
            >
              <thead>
                <tr style={{ background: "#f3f4f6" }}>
                  <th style={{ padding: 10, textAlign: "left" }}>
                    Employee
                  </th>
                  <th style={{ padding: 10, textAlign: "right" }}>
                    Salary
                  </th>
                  <th style={{ padding: 10, textAlign: "right" }}>
                    Bonus
                  </th>
                  <th style={{ padding: 10, textAlign: "right" }}>
                    Manual Advance
                  </th>
                  <th style={{ padding: 10, textAlign: "right" }}>
                    Carry Forward
                  </th>
                  <th style={{ padding: 10, textAlign: "right" }}>
                    Bonus Carry-in
                  </th>
                  <th style={{ padding: 10, textAlign: "right" }}>
                    Final Opening
                  </th>
                </tr>
              </thead>

              <tbody>
                {(generatedStartingPayableSummary.entries || []).map(
                  (entry) => (
                    <tr
                      key={entry.employeeId}
                      style={{ borderTop: "1px solid #e5e7eb" }}
                    >
                      <td style={{ padding: 10 }}>
                        <div style={{ fontWeight: 800 }}>
                          {entry.employeeName}
                        </div>
                        <div style={{ fontSize: 11, color: "#6b7280" }}>
                          {entry.branch || "—"}
                        </div>
                        {entry.remarks && (
                          <div
                            style={{
                              marginTop: 3,
                              fontSize: 11,
                              color: "#92400e",
                              fontWeight: 700,
                            }}
                          >
                            {entry.remarks}
                          </div>
                        )}
                      </td>

                      <td style={{ padding: 10, textAlign: "right" }}>
                        ₹
                        {Math.round(
                          entry.openingSalaryPayable || 0
                        ).toLocaleString("en-IN")}
                      </td>

                      <td style={{ padding: 10, textAlign: "right" }}>
                        ₹
                        {Math.round(
                          entry.openingBonusPayable || 0
                        ).toLocaleString("en-IN")}
                      </td>

                      <td
                        style={{
                          padding: 10,
                          textAlign: "right",
                          color: "#dc2626",
                          fontWeight: 800,
                        }}
                      >
                        ₹
                        {Math.round(
                          entry.manualAdvancePaid || 0
                        ).toLocaleString("en-IN")}
                      </td>

                      <td style={{ padding: 10, textAlign: "right" }}>
                        {Number(entry.openingCarryForward || 0) < 0
                          ? "−"
                          : ""}
                        ₹
                        {Math.abs(
                          Math.round(entry.openingCarryForward || 0)
                        ).toLocaleString("en-IN")}
                      </td>

                      <td style={{ padding: 10, textAlign: "right" }}>
                        {Number(entry.bonusCarryInDays || 0)}
                      </td>

                      <td
                        style={{
                          padding: 10,
                          textAlign: "right",
                          fontWeight: 900,
                          color:
                            Number(entry.totalOpeningPayable || 0) < 0
                              ? "#dc2626"
                              : "#166534",
                        }}
                      >
                        {Number(entry.totalOpeningPayable || 0) < 0
                          ? "−"
                          : ""}
                        ₹
                        {Math.abs(
                          Math.round(entry.totalOpeningPayable || 0)
                        ).toLocaleString("en-IN")}
                      </td>
                    </tr>
                  )
                )}
                            </tbody>
            </table>
          </div>
        </div>
      )}

      {savedStartingPayableBalances.length > 0 && (
        <div
          className="paper section"
          style={{
            marginTop: 20,
            padding: 16,
            border: "1px solid #e5e7eb",
            background: "#ffffff",
          }}
        >
          <h3 style={{ margin: 0 }}>Saved Starting Balance History</h3>

          <div style={{ marginTop: 14, overflowX: "auto" }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                minWidth: 850,
                fontSize: 13,
              }}
            >
              <thead>
                <tr style={{ background: "#f3f4f6" }}>
                  <th style={{ padding: 10, textAlign: "left" }}>
                    Reference
                  </th>
                  <th style={{ padding: 10, textAlign: "left" }}>
                    Type
                  </th>
                  <th style={{ padding: 10, textAlign: "left" }}>
                    Dates
                  </th>
                  <th style={{ padding: 10, textAlign: "right" }}>
                    Employees
                  </th>
                  <th style={{ padding: 10, textAlign: "right" }}>
                    Final Opening Balance
                  </th>
                  <th style={{ padding: 10, textAlign: "center" }}>
                    Action
                  </th>
                </tr>
              </thead>

              <tbody>
                {savedStartingPayableBalances.map((balance) => (
                  <tr
                    key={balance.id}
                    style={{ borderTop: "1px solid #e5e7eb" }}
                  >
                    <td style={{ padding: 10 }}>
                      <div style={{ fontWeight: 800 }}>
                        {balance.id}
                      </div>
                      <div style={{ fontSize: 11, color: "#6b7280" }}>
                        Saved:{" "}
                        {balance.createdAt
                          ? new Date(balance.createdAt).toLocaleString(
                              "en-IN"
                            )
                          : "—"}
                      </div>
                    </td>

                    <td style={{ padding: 10 }}>
                      {balance.type === "non_contractual"
                        ? "Non-contractual"
                        : "Contractual"}
                    </td>

                    <td style={{ padding: 10 }}>
                      <div>
                        Starting:{" "}
                        {balance.startingBalanceDate
                          ? balance.startingBalanceDate
                              .split("-")
                              .reverse()
                              .join("-")
                          : "—"}
                      </div>
                      <div style={{ fontSize: 11, color: "#6b7280" }}>
                        Covered till:{" "}
                        {balance.coveredTillDate
                          ? balance.coveredTillDate
                              .split("-")
                              .reverse()
                              .join("-")
                          : "—"}
                      </div>
                    </td>

                    <td style={{ padding: 10, textAlign: "right" }}>
                      {(balance.entries || []).length}
                    </td>

                    <td
                      style={{
                        padding: 10,
                        textAlign: "right",
                        fontWeight: 900,
                        color:
                          Number(balance.finalOpeningBalance || 0) < 0
                            ? "#dc2626"
                            : "#166534",
                      }}
                    >
                      {Number(balance.finalOpeningBalance || 0) < 0
                        ? "−"
                        : ""}
                      ₹
                      {Math.abs(
                        Math.round(balance.finalOpeningBalance || 0)
                      ).toLocaleString("en-IN")}
                    </td>

                    <td style={{ padding: 10, textAlign: "center" }}>
                      <button
                        type="button"
                        className="btn"
                        style={{
                          color: "#dc2626",
                          borderColor: "#fecaca",
                          fontWeight: 800,
                        }}
                        onClick={() => {
                          const confirmDelete = window.confirm(
                            `Delete this Starting Payable Balance?\n\nReference: ${balance.id}\n\nThis may change Advance and Payroll calculations that depend on this starting balance.`
                          );

                          if (!confirmDelete) return;

                          setSavedStartingPayableBalances((previous) =>
                            previous.filter(
                              (item) => item.id !== balance.id
                            )
                          );

                          if (
                            generatedStartingPayableSummary?.id === balance.id
                          ) {
                            setGeneratedStartingPayableSummary(null);
                          }
                        }}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

    </div>
  </div>
)}

{page === "attendance" && (

  <div style={{ maxWidth: 1160, margin: "0 auto 40px", padding: "0 12px" }}>
    <div className="paper section" style={{ padding: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <div>

<input
  ref={attendanceImportInputRef}
  type="file"
  accept=".xlsx,.xls"
  style={{ display: "none" }}
  onChange={handleAttendanceExcelImport}
/>


          <h1 style={{ margin: 0 }}>Record Attendance</h1>
          <p style={{ color: "#666", marginTop: 6 }}>
            Mark daily attendance for employees.
          </p>
        </div>

<div style={{ marginTop: 14, display: "flex", gap: 8, flexWrap: "wrap" }}>
  <button
    type="button"
    className={attendanceTab === "contractual" ? "btn primary" : "btn"}
    onClick={() => setAttendanceTab("contractual")}
  >
    Contractual
  </button>

  <button
    type="button"
    className={attendanceTab === "non_contractual" ? "btn primary" : "btn"}
    onClick={() => setAttendanceTab("non_contractual")}
  >
    Non-contractual
  </button>


  <button
    type="button"
    className={attendanceTab === "all" ? "btn primary" : "btn"}
    onClick={() => setAttendanceTab("all")}
  >
    All
  </button>


<button
  type="button"
  className="btn"
  onClick={() => setShowAttendanceImport((v) => !v)}
>
  Import Attendance
</button>

  <button
    type="button"
    className="btn primary"
    onClick={() => {
      setPayrollTab(attendanceTab);
      setPayrollShowAll(false);
      setEditingPayrollEmployeeId(null);

      setEmployeeForm({
  type: attendanceTab,
  name: "",
  dob: "",
  address: "",
  joining_date: "",
  base_salary: "",
  phone: "",
  designation: "",
  branch: "",
  weekly_off: "sunday",
});

      setShowEmployeeForm(true);
      setPage("payroll");
    }}
  >
    + Add Employee
  </button>

  <button
    type="button"
    className="btn"
    onClick={() => {
      setPayrollTab(attendanceTab);
      setPayrollShowAll(false);
      setShowEmployeeForm(false);
      setSelectedPayrollEmployee(null);
      setPage("payroll");
    }}
  >
    Manage Employees
  </button>
</div>

{showAttendanceImport && (
  <div
    className="paper section"
    style={{
      marginTop: 16,
      padding: 16,
      border: "1px solid #e5e7eb",
      background: "#f9fafb",
      width: "100%",
    }}
  >
    <h3 style={{ marginTop: 0 }}>Import Attendance</h3>

    <div
      style={{
        display: "flex",
        gap: 12,
        flexWrap: "wrap",
        alignItems: "end",
      }}
    >
      <div>
        <div style={{ fontSize: 12, marginBottom: 6 }}>From Date</div>
        <input
          type="date"
          value={attendanceImportFromDate}
          onChange={(e) => setAttendanceImportFromDate(e.target.value)}
        />
      </div>

      <div>
        <div style={{ fontSize: 12, marginBottom: 6 }}>To Date</div>
        <input
          type="date"
          value={attendanceImportToDate}
          onChange={(e) => setAttendanceImportToDate(e.target.value)}
        />
      </div>

      <button
  type="button"
  className="btn primary"
  onClick={generateAttendanceTemplate}
>
  Generate Template
</button>

      <button
        type="button"
        className="btn"
        onClick={() => attendanceImportInputRef.current?.click()}
      >
        Upload Attendance
      </button>
    </div>

    {attendanceImportPreviewRows.length > 0 && (
      <div style={{ marginTop: 18, overflowX: "auto" }}>
        <h4 style={{ marginBottom: 10 }}>Attendance Import Summary</h4>

        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            minWidth: 900,
            fontSize: 13,
          }}
        >
          <thead>
            <tr style={{ background: "#eef4ff" }}>
              <th style={{ padding: 8, textAlign: "left" }}>Employee</th>
              <th style={{ padding: 8, textAlign: "center" }}>Present</th>
              <th style={{ padding: 8, textAlign: "center" }}>Absent</th>
              <th style={{ padding: 8, textAlign: "center" }}>Half Day</th>
              <th style={{ padding: 8, textAlign: "center" }}>Week Off</th>
              <th style={{ padding: 8, textAlign: "center" }}>Public Holiday</th>
              <th style={{ padding: 8, textAlign: "center" }}>Blank</th>
            </tr>
          </thead>

          <tbody>
            {attendanceImportPreviewRows.map((row) => (
              <tr key={row.employee_id} style={{ borderTop: "1px solid #e5e7eb" }}>
                <td style={{ padding: 8, fontWeight: 700 }}>
                  {row.employee_name}
                  <div style={{ fontSize: 12, color: "#666" }}>
                    {row.branch || "-"}
                  </div>
                </td>
                <td style={{ padding: 8, textAlign: "center", color: "#166534", fontWeight: 700 }}>{row.present}</td>
                <td style={{ padding: 8, textAlign: "center", color: "#dc2626", fontWeight: 700 }}>{row.absent}</td>
                <td style={{ padding: 8, textAlign: "center", color: "#b45309", fontWeight: 700 }}>{row.halfday}</td>
                <td style={{ padding: 8, textAlign: "center", color: "#2563eb", fontWeight: 700 }}>{row.weeklyOff}</td>
                <td style={{ padding: 8, textAlign: "center", color: "#7c3aed", fontWeight: 700 }}>{row.publicHoliday}</td>
                <td style={{ padding: 8, textAlign: "center", color: "#6b7280", fontWeight: 700 }}>{row.blanks}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div style={{ marginTop: 14, display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setAttendanceImportPreviewRows([]);
              setAttendanceImportPendingEntries({});
            }}
          >
            Clear Preview
          </button>

          <button
            type="button"
            className="btn primary"
            onClick={() => {
              const updated = {
                ...attendanceEntries,
                ...attendanceImportPendingEntries,
              };

              setAttendanceEntries(updated);

              localStorage.setItem(
                "hvf.attendanceEntries",
                JSON.stringify(updated)
              );

              setAttendanceImportPreviewRows([]);
              setAttendanceImportPendingEntries({});

              alert("Attendance imported and saved successfully.");
            }}
          >
            Final Save Attendance
          </button>
        </div>
      </div>
    )}
  </div>
)}

<div
  style={{
    marginTop: 10,
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 12px",
    borderRadius: 999,
    background:
      attendanceTab === "contractual"
        ? "#dbeafe"
        : "#fef3c7",
    color:
      attendanceTab === "contractual"
        ? "#1d4ed8"
        : "#b45309",
    fontWeight: 700,
    fontSize: 13,
  }}
>
  {attendanceTab === "contractual"
    ? "Contractual Attendance Mode"
    : "Non-contractual Attendance Mode"}
</div>

<div style={{ marginTop: 8, fontSize: 13, color: "#374151" }}>
  Date: <b>{attendanceDate}</b> • Employees: <b>{payrollEmployees.length}</b>

{attendanceEntries[`${attendanceDate}_saved_at`] && (
  <span style={{ marginLeft: 10, color: "#666" }}>
    • Saved:
    {" "}
    {new Date(
      attendanceEntries[`${attendanceDate}_saved_at`]
    ).toLocaleString("en-IN", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    })}
  </span>
)}
</div>

<div style={{ marginTop: 6, fontSize: 12, color: "#6b7280" }}>
  Changes recorded today:{" "}
  <b>
    {
      attendanceHistory.filter((h) => h.date === attendanceDate).length
    }
  </b>
</div>

<div
  style={{
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(120px, 1fr))",
    gap: 10,
    marginTop: 18,
    width: "100%",
    gridColumn: "1 / -1",
  }}
>
  <div className="paper section" style={{ padding: 12 }}>
    <div style={{ fontSize: 12, color: "#666" }}>Present</div>
    <div style={{ fontSize: 22, fontWeight: 800, color: "#166534" }}>
      {
        payrollEmployees.filter((emp) => {
          const key = `${attendanceDate}_${emp.id}`;
          return (attendanceEntries[key] || "present") === "present";
        }).length
      }
    </div>
  </div>

  <div className="paper section" style={{ padding: 12 }}>
    <div style={{ fontSize: 12, color: "#666" }}>Absent</div>
    <div style={{ fontSize: 22, fontWeight: 800, color: "#dc2626" }}>
      {
        payrollEmployees.filter((emp) => {
          const key = `${attendanceDate}_${emp.id}`;
          return attendanceEntries[key] === "absent";
        }).length
      }
    </div>
  </div>

  <div className="paper section" style={{ padding: 12 }}>
    <div style={{ fontSize: 12, color: "#666" }}>Half Day</div>
    <div style={{ fontSize: 22, fontWeight: 800, color: "#b45309" }}>
      {
        payrollEmployees.filter((emp) => {
          const key = `${attendanceDate}_${emp.id}`;
          return attendanceEntries[key] === "halfday";
        }).length
      }
    </div>
  </div>
</div>

        <button className="btn" onClick={backToCatalog}>
          ← Back to Catalog
        </button>
      </div>

      <div className="paper section" style={{ marginTop: 18, padding: 16 }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>Attendance Date</div>

        <input
          type="date"
          value={attendanceDate}
          onChange={(e) => {
  const selectedDate = e.target.value;
  const today = new Date().toISOString().slice(0, 10);

  if (selectedDate < today) {
    const ok = window.confirm(
      "You are selecting a previous date. Continue?"
    );

    if (!ok) return;
  }

  setAttendanceDate(selectedDate);
}}
          style={{
            padding: 10,
            borderRadius: 10,
            border: "1px solid #d1d5db",
            fontSize: 16,
          }}
        />
      </div>

      <div className="paper section" style={{ marginTop: 18, padding: 0, overflow: "hidden" }}>
        {payrollEmployees.length === 0 ? (
          <div style={{ padding: 20, color: "#777" }}>
            No employees added yet.
          </div>
        ) : (
          payrollEmployees
  .filter(
    (emp) =>
      (attendanceTab === "all" || emp.type === attendanceTab) &&
      (emp.status || "active") === "active"
  )
  .sort((a, b) => {
    const typeOrder = {
      contractual: 1,
      non_contractual: 2,
    };

    return (typeOrder[a.type] || 99) - (typeOrder[b.type] || 99);
  })
  .map((emp, index, filteredEmployees) => {
 
            const attendanceKey = `${attendanceDate}_${emp.id}`;
           const dayName = new Date(attendanceDate)
  .toLocaleDateString("en-US", { weekday: "long" })
  .toLowerCase();

const effectiveWeeklyOff = getEmployeeWeeklyOffForDate(emp, attendanceDate);

const defaultStatus =
effectiveWeeklyOff &&
effectiveWeeklyOff !== "none" &&
effectiveWeeklyOff === dayName
? "weekoff"
: "present";

const currentStatus = attendanceEntries[attendanceKey] || defaultStatus;

            return (
              <div
                key={emp.id}
                style={{
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 12,
  padding: 14,
  borderTop: "1px solid #eee",
  flexWrap: "wrap",
  background:
  currentStatus === "present"
    ? "#f0fdf4"
    : currentStatus === "absent"
    ? "#fef2f2"
    : currentStatus === "halfday"
    ? "#fffbeb"
    : currentStatus === "weekoff"
    ? "#eff6ff"
    : "#f5f3ff",
}}
              >
                <div>
                  <div style={{ fontWeight: 700 }}>{emp.name}</div>

<div
  style={{
    marginTop: 4,
    fontSize: 12,
    fontWeight: 700,
    color:
  currentStatus === "present"
    ? "#166534"
    : currentStatus === "absent"
    ? "#dc2626"
    : currentStatus === "halfday"
    ? "#b45309"
    : currentStatus === "weekoff"
    ? "#2563eb"
    : "#7c3aed",
  }}
>
  {currentStatus === "present"
  ? "Present"
  : currentStatus === "absent"
  ? "Absent"
  : currentStatus === "halfday"
  ? "Half Day"
  : currentStatus === "weekoff"
  ? "Weekly Off"
  : "Public Holiday"}
</div>

<div style={{ fontSize: 13, color: "#666", marginTop: 4 }}>
  {emp.branch || "-"}
</div>
                </div>

                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {["present", "absent", "halfday", "weekoff", "publicholiday"].map((status) => (
                    <button
                      key={status}
                      type="button"
                      onClick={() => {
                        const previousStatus = attendanceEntries[attendanceKey] || "present";

const updated = {
  ...attendanceEntries,
  [attendanceKey]: status,
};

setAttendanceEntries(updated);

localStorage.setItem(
  "hvf.attendanceEntries",
  JSON.stringify(updated)
);

const historyItem = {
  id: Date.now(),
  date: attendanceDate,
  employee_id: emp.id,
  employee_name: emp.name,
  previous_status: previousStatus,
  new_status: status,
  changed_at: new Date().toISOString(),
  changed_by: "Admin/Manager",
};

const updatedHistory = [...attendanceHistory, historyItem];

setAttendanceHistory(updatedHistory);

localStorage.setItem(
  "hvf.attendanceHistory",
  JSON.stringify(updatedHistory)
);

                      }}
                      style={{
                        padding: "8px 12px",
                        borderRadius: 10,
                        border:
                          currentStatus === status
                            ? "2px solid #2563eb"
                            : "1px solid #d1d5db",
                        background:
                          currentStatus === status ? "#eff6ff" : "#fff",
                        fontWeight: 700,
                        cursor: "pointer",
                      }}
                    >
                    {status === "present"
  ? "Present"
  : status === "absent"
  ? "Absent"
  : status === "halfday"
  ? "Half Day"
  : status === "weekoff"
  ? "Weekly Off"
  : "Public Holiday"}
                    </button>
                  ))}
                </div>
              </div>
            );
          })
        )}
      </div>

<div
  className="paper section"
  style={{
    marginTop: 18,
    padding: 16,
  }}
>
 <div
  style={{
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    alignItems: "center",
    flexWrap: "wrap",
  }}
>
  <div>
    <h3 style={{ marginTop: 0, marginBottom: 4 }}>
      Monthly Attendance Register
    </h3>

<div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "end" }}>
 <button
  type="button"
  className={attendanceRegisterMode === "cycle" ? "btn primary" : "btn"}
  onClick={() => {
    setAttendanceRegisterMode("cycle");
    localStorage.setItem("hvf.attendanceRegisterMode", "cycle");
  }}
>
  Current Cycle
</button>

 <button
  type="button"
  className={attendanceRegisterMode === "custom" ? "btn primary" : "btn"}
  onClick={() => {
    setAttendanceRegisterMode("custom");
    localStorage.setItem("hvf.attendanceRegisterMode", "custom");
  }}
>
  Custom Range
</button>

<button
  type="button"
  className="btn"
  onClick={printAttendanceRegisterPdf}
>
  Print PDF
</button>

  {attendanceRegisterMode === "custom" && (
    <>
     <input
  type="date"
  value={attendanceRegisterFromDate}
  onChange={(e) => {
    setAttendanceRegisterFromDate(e.target.value);
    localStorage.setItem("hvf.attendanceRegisterFromDate", e.target.value);
  }}
/>

      <input
  type="date"
  value={attendanceRegisterToDate}
  onChange={(e) => {
    setAttendanceRegisterToDate(e.target.value);
    localStorage.setItem("hvf.attendanceRegisterToDate", e.target.value);
  }}
/>
    </>
  )}
</div>

   <div style={{ color: "#666", fontSize: 13 }}>
  {attendanceTab === "contractual"
    ? "Attendance period: 1st to last day of selected month"
    : "Attendance period: 27th previous month to 26th selected month"}

  <div style={{ marginTop: 4 }}>
    Viewing:
    {" "}
    <b>
      {new Date(attendanceDate).toLocaleString("en-IN", {
        month: "long",
        year: "numeric",
      })}
    </b>
  </div>
</div>
  </div>

<div
  style={{
    display: "flex",
    gap: 10,
    flexWrap: "wrap",
    marginTop: 12,
    marginBottom: 10,
    fontSize: 12,
    fontWeight: 700,
  }}
>
  <div
    style={{
      padding: "6px 10px",
      borderRadius: 999,
      background: "#dcfce7",
      color: "#166534",
    }}
  >
    P = Present
  </div>

  <div
    style={{
      padding: "6px 10px",
      borderRadius: 999,
      background: "#fee2e2",
      color: "#dc2626",
    }}
  >
    A = Absent
  </div>

  <div
    style={{
      padding: "6px 10px",
      borderRadius: 999,
      background: "#fef3c7",
      color: "#b45309",
    }}
  >
    H = Half Day
  </div>

  <div
    style={{
      padding: "6px 10px",
      borderRadius: 999,
      background: "#dbeafe",
      color: "#2563eb",
    }}
  >
    W = Weekly Off
  </div>

  <div
    style={{
      padding: "6px 10px",
      borderRadius: 999,
      background: "#ede9fe",
      color: "#7c3aed",
    }}
  >
    PH = Public Holiday
  </div>
</div>

  <input
    type="month"
    value={attendanceDate.slice(0, 7)}
    onChange={(e) => {
      const selectedMonth = e.target.value;

      setAttendanceDate(`${selectedMonth}-01`);
    }}
    style={{
      padding: 10,
      borderRadius: 10,
      border: "1px solid #d1d5db",
      fontSize: 14,
    }}
  />

<div style={{ marginTop: 14, overflowX: "auto" }}>
  <table
    style={{
      width: "100%",
      borderCollapse: "collapse",
      minWidth: 700,
      fontSize: 13,
    }}
  >
    <thead>
      <tr style={{ background: "#f3f4f6" }}>
        <th style={{ padding: 8, textAlign: "left" }}>Employee</th>
<th style={{ padding: 8, textAlign: "center" }}>P</th>
<th style={{ padding: 8, textAlign: "center" }}>A</th>
<th style={{ padding: 8, textAlign: "center" }}>H</th>
<th style={{ padding: 8, textAlign: "center" }}>PH</th>
<th style={{ padding: 8, textAlign: "center" }}>W</th>
<th style={{ padding: 8, textAlign: "center" }}>Payable</th>
        {(() => {
  const range = getAttendanceRegisterRange();
  const dates = getDateRangeList(range.from, range.to);

  return dates.map((dateKey, i) => {
    const [year, month, day] = dateKey.split("-");

    return (
      <th key={i} style={{ padding: 8, textAlign: "center" }}>
        {`${day}/${month}`}
      </th>
    );
  });
})()}
      </tr>
    </thead>

    <tbody>
      {payrollEmployees
  .filter(
    (emp) =>
      (attendanceTab === "all" || emp.type === attendanceTab) &&
      (emp.status || "active") === "active"
  )
  .sort((a, b) => {
    const typeOrder = {
      contractual: 1,
      non_contractual: 2,
    };

    return (typeOrder[a.type] || 99) - (typeOrder[b.type] || 99);
  })
  .map((emp, index, filteredEmployees) => {
  const showGroupHeader =
    attendanceTab === "all" &&
    (index === 0 || emp.type !== filteredEmployees[index - 1].type);

  const groupTitle =
    emp.type === "contractual"
      ? "Contractual Employees"
      : "Non-contractual Employees";

  return (
    <React.Fragment key={emp.id}>
      {showGroupHeader && (
        <tr>
          <td
            colSpan={
              7 +
              getDateRangeList(
                getAttendanceRegisterRange().from,
                getAttendanceRegisterRange().to
              ).length
            }
            style={{
              padding: 10,
              background: "#eef2ff",
              color: "#1e3a8a",
              fontWeight: 800,
              textAlign: "center",
              borderTop: "2px solid #c7d2fe",
              borderBottom: "2px solid #c7d2fe",
            }}
          >
            {groupTitle}
          </td>
        </tr>
      )}

      <tr>
         <td style={{ padding: 8, fontWeight: 700 }}>
  {emp.name}
</td>

<td style={{ padding: 8, textAlign: "center", fontWeight: 700, color: "#166534" }}>
  {
    getDateRangeList(
      getAttendanceRegisterRange().from,
      getAttendanceRegisterRange().to
    )
      .map((dateKey) => {
        const key = `${dateKey}_${emp.id}`;
        return attendanceEntries[key] === "present" ? 1 : 0;
      })
      .reduce((a, b) => a + b, 0)
  }
</td>

<td style={{ padding: 8, textAlign: "center", fontWeight: 700, color: "#dc2626" }}>
  {
    getDateRangeList(
      getAttendanceRegisterRange().from,
      getAttendanceRegisterRange().to
    )
      .map((dateKey) => {
        const key = `${dateKey}_${emp.id}`;
        return attendanceEntries[key] === "absent" ? 1 : 0;
      })
      .reduce((a, b) => a + b, 0)
  }
</td>

<td style={{ padding: 8, textAlign: "center", fontWeight: 700, color: "#b45309" }}>
  {
    getDateRangeList(
      getAttendanceRegisterRange().from,
      getAttendanceRegisterRange().to
    )
      .map((dateKey) => {
        const key = `${dateKey}_${emp.id}`;
        return attendanceEntries[key] === "halfday" ? 0.5 : 0;
      })
      .reduce((a, b) => a + b, 0)
  }
</td>


<td
  style={{
    padding: 8,
    textAlign: "center",
    fontWeight: 700,
    color: "#7c3aed",
  }}
>
  {
    getDateRangeList(
      getAttendanceRegisterRange().from,
      getAttendanceRegisterRange().to
    )
      .map((dateKey) => {
        const key = `${dateKey}_${emp.id}`;
        return attendanceEntries[key] === "publicholiday" ? 1 : 0;
      })
      .reduce((a, b) => a + b, 0)
  }
</td>

<td
  style={{
    padding: 8,
    textAlign: "center",
    fontWeight: 700,
    color: "#2563eb",
  }}
>
  {
    getDateRangeList(
      getAttendanceRegisterRange().from,
      getAttendanceRegisterRange().to
    )
      .map((dateKey) => {
        const key = `${dateKey}_${emp.id}`;
        return attendanceEntries[key] === "weekoff" ? 1 : 0;
      })
      .reduce((a, b) => a + b, 0)
  }
</td>


<td
  style={{
    padding: 8,
    textAlign: "center",
    fontWeight: 700,
    color: "#2563eb",
  }}
>
  {
    (
      getDateRangeList(
        getAttendanceRegisterRange().from,
        getAttendanceRegisterRange().to
      )
        .map((dateKey) => {
          const key = `${dateKey}_${emp.id}`;

          if (attendanceEntries[key] === "present") return 1;
          if (attendanceEntries[key] === "halfday") return 0.5;
if (attendanceEntries[key] === "publicholiday") return 1;

          return 0;
        })
        .reduce((a, b) => a + b, 0)
    ).toFixed(1)
  }
</td>

{getDateRangeList(
            getAttendanceRegisterRange().from,
            getAttendanceRegisterRange().to
          ).map((dateKey, i) => {
            const key = `${dateKey}_${emp.id}`;
            const dayName = new Date(dateKey)
  .toLocaleDateString("en-US", { weekday: "long" })
  .toLowerCase();

const joined =
  emp.joining_date &&
  new Date(dateKey) >= new Date(emp.joining_date);

const effectiveWeeklyOff = getEmployeeWeeklyOffForDate(emp, dateKey);

const defaultStatus =
  joined &&
  effectiveWeeklyOff &&
  effectiveWeeklyOff !== "none" &&
  effectiveWeeklyOff === dayName
    ? "weekoff"
    : "";

const status = !joined
  ? "notjoined"
  : attendanceEntries[key] || defaultStatus;

            return (
              <td
                key={i}
                style={{
                  padding: 8,
                  textAlign: "center",
                  background:
                    status === "present"
                      ? "#dcfce7"
                      : status === "absent"
                      ? "#fee2e2"
                      : status === "halfday"
  ? "#fef3c7"
  : status === "weekoff"
  ? "#dbeafe"
  : status === "publicholiday"
  ? "#ede9fe"
  : status === "notjoined"
  ? "#f3f4f6"
  : "#fff",
                }}
              >
                {status === "present"
  ? "P"
  : status === "absent"
  ? "A"
  : status === "halfday"
  ? "H"
  : status === "weekoff"
  ? "W"
  : status === "publicholiday"
  ? "PH"
  : status === "notjoined"
  ? "-"
  : ""}
              </td>
);
})}
</tr>
</React.Fragment>
);
})}
    </tbody>
  </table>
</div>

</div>
</div>


<div
  style={{
    marginTop: 18,
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    flexWrap: "wrap",
  }}
>
  <button
    type="button"
    className="btn"
    style={{
      background: "#eff6ff",
      color: "#1d4ed8",
      borderColor: "#bfdbfe",
      fontWeight: 800,
    }}
    onClick={() => setPage("startingPayableBalance")}
  >
    Manage Starting Payable Balance
  </button>

  <div style={{ textAlign: "right" }}>

  <button
    type="button"
    className="btn primary"
    onClick={() => {
  const updated = {
  ...attendanceEntries,
  [`${attendanceDate}_saved_at`]: new Date().toISOString(),
};

payrollEmployees
  .filter((emp) => emp.type === attendanceTab)
  .forEach((emp) => {
    const key = `${attendanceDate}_${emp.id}`;

    if (updated[key]) return;

    const dayName = new Date(attendanceDate)
      .toLocaleDateString("en-US", { weekday: "long" })
      .toLowerCase();

    if (
      emp.weekly_off &&
      emp.weekly_off !== "none" &&
      emp.weekly_off === dayName
    ) {
      updated[key] = "weekoff";
    }
  });

setAttendanceEntries(updated);

localStorage.setItem(
  "hvf.attendanceEntries",
  JSON.stringify(updated)
);

const historyItem = {
  id: Date.now(),
  type: "save",
  date: attendanceDate,
  changed_at: new Date().toISOString(),
  changed_by: "Admin/Manager",
};

const updatedHistory = [...attendanceHistory, historyItem];

setAttendanceHistory(updatedHistory);

localStorage.setItem(
  "hvf.attendanceHistory",
  JSON.stringify(updatedHistory)
);

alert("Attendance saved ✅");
}}
  >
    Save Attendance
  </button>

<button
  type="button"
  className="btn"
  style={{
    marginLeft: 10,
    background: "#fee2e2",
    color: "#b91c1c",
    borderColor: "#fecaca",
  }}
  onClick={() => {

if (!window.confirm("Clear attendance for this selected date?")) return;
    const updated = { ...attendanceEntries };


    Object.keys(updated).forEach((key) => {
      if (key.startsWith(attendanceDate + "_")) {
        delete updated[key];
      }
    });

    setAttendanceEntries(updated);

    localStorage.setItem(
      "hvf.attendanceEntries",
      JSON.stringify(updated)
    );

    alert("Attendance cleared for selected date.");
  }}
>
  Clear Date
</button>

<button
  type="button"
  className="btn"
  style={{
    marginLeft: 10,
  }}
  onClick={() => {
    const logs = attendanceHistory.filter(
      (h) => h.date === attendanceDate
    );

    if (!logs.length) {
      alert("No attendance history for this date.");
      return;
    }

    alert(
      logs
        .map(
          (h) =>
            h.type === "save"
  ? `Attendance saved by ${h.changed_by}`
  : `${h.employee_name}: ${h.previous_status} → ${h.new_status}`
        )
        .join("\n")
    );
  }}
>
  View History
</button>

  </div>
</div>

    </div>
  </div>
)}




{page === "payroll" && (
  <div style={{ maxWidth: 1100, margin: "0 auto 40px", padding: "0 12px" }}>
    <div className="paper section" style={{ padding: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <div>


<input
  ref={employeeImportInputRef}
  type="file"
  accept=".xlsx,.xls"
  style={{ display: "none" }}
  onChange={handleEmployeeExcelImport}
/>


          <h1 style={{ margin: 0 }}>Staff Attendance & Payroll</h1>
          <p style={{ color: "#666", marginTop: 6 }}>
            Manage contractual and non-contractual staff payroll records.
          </p>
        </div>

        <button className="btn" onClick={backToCatalog}>
          ← Back to Catalog
        </button>
      </div>

      <div style={{ marginTop: 18, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <button
          type="button"
          className={payrollTab === "contractual" && !payrollShowAll ? "btn primary" : "btn"}
          onClick={() => {
            setPayrollTab("contractual");
            setPayrollShowAll(false);
          }}
        >
          Contractual
        </button>

        <button
          type="button"
          className={payrollTab === "non_contractual" && !payrollShowAll ? "btn primary" : "btn"}
          onClick={() => {
            setPayrollTab("non_contractual");
            setPayrollShowAll(false);
          }}
        >
          Non-contractual
        </button>

        <button
  type="button"
  className="btn"
  onClick={() => setPayrollShowAll((v) => !v)}
  style={{
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    borderRadius: 10,
    background: payrollShowAll ? "#f0fdf4" : "#fff",
    border: payrollShowAll ? "1px solid #22c55e" : "1px solid #e5e7eb",
    color: "#111827",
  }}
>
  <span>{payrollShowAll ? "☑" : "☐"}</span>
  <span>Show all together</span>
</button>
      </div>

      <div style={{ marginTop: 18, display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button
          type="button"
          className="btn primary"
          onClick={() => {
  setEditingPayrollEmployeeId(null);

  setEmployeeForm({
  type: payrollShowAll ? "contractual" : payrollTab,
  name: "",
  dob: "",
  address: "",
  joining_date: "",
  base_salary: "",
  phone: "",
  designation: "",
  branch: "",
weekly_off: "sunday",
status: "active",
});

  setShowEmployeeForm(true);
}}
        >
          + Add Employee
        </button>

        <button
          type="button"
          className="btn"
          onClick={() => employeeImportInputRef.current?.click()}
        >
          Import Employees
        </button>
      </div>


{showEmployeeImport && (
  <div
    className="paper section"
    style={{
      marginTop: 18,
      padding: 16,
      border: "1px solid #e5e7eb",
      background: "#f9fafb",
    }}
  >
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 12,
        alignItems: "center",
        flexWrap: "wrap",
      }}
    >
      <div>
        <h3 style={{ margin: 0 }}>Import Employees Preview</h3>
        <div style={{ color: "#666", fontSize: 13, marginTop: 4 }}>
          Review and correct employee details before saving.
        </div>
      </div>

      <button
        type="button"
        className="btn"
        onClick={() => {
          setShowEmployeeImport(false);
          setEmployeeImportRows([]);
        }}
      >
        Cancel Import
      </button>
    </div>

    <div style={{ marginTop: 14, overflowX: "auto" }}>
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          minWidth: 1200,
          fontSize: 13,
        }}
      >
        <thead>
          <tr style={{ background: "#eef4ff" }}>
            <th style={{ padding: 8 }}>Type</th>
            <th style={{ padding: 8 }}>Name</th>
            <th style={{ padding: 8 }}>Phone</th>
            <th style={{ padding: 8 }}>DOB</th>
            <th style={{ padding: 8 }}>Joining</th>
            <th style={{ padding: 8 }}>Salary</th>
            <th style={{ padding: 8 }}>Designation</th>
            <th style={{ padding: 8 }}>Branch</th>
            <th style={{ padding: 8 }}>Address</th>
          </tr>
        </thead>

        <tbody>
          {employeeImportRows.map((emp, index) => (
            <tr key={emp.id} style={{ borderTop: "1px solid #e5e7eb" }}>
              {[
                "type",
                "name",
                "phone",
                "dob",
                "joining_date",
                "base_salary",
                "designation",
                "branch",
                "address",
              ].map((field) => (
                <td key={field} style={{ padding: 6 }}>
                  <input
                    value={employeeImportRows[index][field] || ""}
                    onChange={(e) => {
                      const updated = [...employeeImportRows];
                      updated[index] = {
                        ...updated[index],
                        [field]:
                          field === "base_salary"
                            ? Number(e.target.value || 0)
                            : e.target.value,
                      };
                      setEmployeeImportRows(updated);
                    }}
                    style={{
                      width: field === "address" ? 180 : 130,
                      padding: 8,
                      borderRadius: 8,
                      border: "1px solid #d1d5db",
                    }}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>

    <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
      <button
        type="button"
        className="btn primary"
        onClick={() => {
          if (!employeeImportRows.length) {
            alert("No employees to import.");
            return;
          }

          const finalEmployees = employeeImportRows.map((emp, index) => ({
            id: index + 1,
            type: emp.type || "non_contractual",
            name: emp.name || "",
            dob: emp.dob || "",
            address: emp.address || "",
            joining_date: emp.joining_date || "",
            base_salary: Number(emp.base_salary || 0),
            phone: emp.phone || "",
            designation: emp.designation || "",
            branch: emp.branch || "",
          }));

          setPayrollEmployees(finalEmployees);

          localStorage.setItem(
            "hvf.payrollEmployees",
            JSON.stringify(finalEmployees)
          );

          setShowEmployeeImport(false);
          setEmployeeImportRows([]);

          alert("Employees imported successfully.");
        }}
      >
        Save Imported Employees
      </button>
    </div>
  </div>
)}


{showEmployeeForm && (
  <div
  ref={employeeFormRef}
  className="paper section"
  style={{
    marginTop: 18,
    padding: 16,
    border: "1px solid #e5e7eb",
    background: "#f9fafb",
  }}
>
    <h3 style={{ marginTop: 0 }}>
  {editingPayrollEmployeeId ? "Edit Employee" : "Add Employee"}
</h3>

    <div className="addform-grid">
      <label>
        <div style={{ fontSize: 12, color: "#666" }}>Employee Type</div>
        <select
          name="type"
          value={employeeForm.type}
          onChange={(e) =>
            setEmployeeForm((f) => ({ ...f, type: e.target.value }))
          }
        >
          <option value="contractual">Contractual</option>
          <option value="non_contractual">Non-contractual</option>
        </select>
      </label>

      <label>
        <div style={{ fontSize: 12, color: "#666" }}>Name *</div>
        <input
          name="name"
          value={employeeForm.name}
          onChange={(e) =>
            setEmployeeForm((f) => ({ ...f, name: e.target.value }))
          }
          placeholder="Employee name"
        />
      </label>

      <label>
        <div style={{ fontSize: 12, color: "#666" }}>Phone</div>
        <input
          name="phone"
          value={employeeForm.phone}
          onChange={(e) =>
            setEmployeeForm((f) => ({ ...f, phone: e.target.value }))
          }
          placeholder="Phone number"
        />
      </label>

      <label>
        <div style={{ fontSize: 12, color: "#666" }}>Date of Birth</div>
        <input
          type="date"
          name="dob"
          value={employeeForm.dob}
          onChange={(e) =>
            setEmployeeForm((f) => ({ ...f, dob: e.target.value }))
          }
        />
      </label>

      <label>
        <div style={{ fontSize: 12, color: "#666" }}>Joining Date</div>
        <input
          type="date"
          name="joining_date"
          value={employeeForm.joining_date}
          onChange={(e) =>
            setEmployeeForm((f) => ({ ...f, joining_date: e.target.value }))
          }
        />
      </label>

      <label>
        <div style={{ fontSize: 12, color: "#666" }}>Base Salary *</div>
        <input
          type="number"
          name="base_salary"
          value={employeeForm.base_salary}
          onChange={(e) =>
            setEmployeeForm((f) => ({ ...f, base_salary: e.target.value }))
          }
          placeholder="Monthly salary"
          min="0"
        />
      </label>

      <label>
        <div style={{ fontSize: 12, color: "#666" }}>Designation</div>
        <input
          name="designation"
          value={employeeForm.designation}
          onChange={(e) =>
            setEmployeeForm((f) => ({ ...f, designation: e.target.value }))
          }
          placeholder="Salesman / Mechanic / Staff"
        />
      </label>

      <label>
        <div style={{ fontSize: 12, color: "#666" }}>Branch</div>
        <input
          name="branch"
          value={employeeForm.branch}
          onChange={(e) =>
            setEmployeeForm((f) => ({ ...f, branch: e.target.value }))
          }
          placeholder="Moranhat / Guwahati / Tinsukia"
        />
      </label>


<label>
  <div style={{ fontSize: 12, color: "#666" }}>Weekly Off</div>
  <select
    value={employeeForm.weekly_off || "sunday"}
    onChange={(e) =>
      setEmployeeForm((f) => ({ ...f, weekly_off: e.target.value }))
    }
  >
    <option value="sunday">Sunday</option>
    <option value="monday">Monday</option>
    <option value="tuesday">Tuesday</option>
    <option value="wednesday">Wednesday</option>
    <option value="thursday">Thursday</option>
    <option value="friday">Friday</option>
    <option value="saturday">Saturday</option>
    <option value="none">No fixed weekly off</option>
  </select>
</label>


<label>
  <div style={{ fontSize: 12, color: "#666" }}>Employee Status</div>
 <select
  value={employeeForm.status || "active"}
  onChange={(e) =>
    setEmployeeForm((f) => ({ ...f, status: e.target.value }))
  }
>
  <option value="active">Active</option>
  <option value="left">Left</option>
</select>
</label>

      <label style={{ gridColumn: "1 / -1" }}>
        <div style={{ fontSize: 12, color: "#666" }}>Address</div>
        <input
          name="address"
          value={employeeForm.address}
          onChange={(e) =>
            setEmployeeForm((f) => ({ ...f, address: e.target.value }))
          }
          placeholder="Employee address"
        />
      </label>
    </div>

    <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
     <button type="button" className="btn primary" onClick={savePayrollEmployee}>
  {editingPayrollEmployeeId ? "Update Employee" : "Save Employee"}
</button>

{editingPayrollEmployeeId && (
  <button
    type="button"
    className="btn"
    onClick={() => {
      const newWeeklyOff = prompt(
        "Enter new weekly off (sunday, monday, tuesday, wednesday, thursday, friday, saturday, none)",
        employeeForm.weekly_off || "sunday"
      );

      if (!newWeeklyOff) return;

      changePayrollEmployeeWeeklyOff(
        editingPayrollEmployeeId,
        newWeeklyOff.toLowerCase()
      );

      alert("Weekly off updated from today onwards.");
    }}
  >
    Change to New Weekly Off
  </button>
)}

      <button
  type="button"
  className="btn"
  onClick={() => { 
    setShowEmployeeForm(false);
    setEditingPayrollEmployeeId(null);
  }}
>
  Cancel
</button>
    </div>
  </div>
)}

<div
  className="paper section"
  style={{
    marginTop: 18,
    padding: 16,
    border: "1px solid #e5e7eb",
    background: "#ffffff",
  }}
>
  <div
    style={{
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      gap: 12,
      flexWrap: "wrap",
    }}
  >
    <div>
      <h3 style={{ margin: 0 }}>Payroll Worksheet</h3>
      <p style={{ margin: "6px 0 0", color: "#666" }}>
        Select month and create attendance/payroll worksheet.
      </p>
    </div>

    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      <label style={{ display: "grid", gap: 4 }}>
  <span style={{ fontSize: 12, color: "#666", fontWeight: 700 }}>
    Payroll Month
  </span>

  <select
    value={payrollMonth}
    onChange={(e) => setPayrollMonth(e.target.value)}
    style={{
      minWidth: 180,
      padding: "10px 12px",
      borderRadius: 10,
      border: "1px solid #d1d5db",
      background: "#fff",
    }}
  >
    <option value="">Select Month</option>
    <option value="January">January</option>
    <option value="February">February</option>
    <option value="March">March</option>
    <option value="April">April</option>
    <option value="May">May</option>
    <option value="June">June</option>
    <option value="July">July</option>
    <option value="August">August</option>
    <option value="September">September</option>
    <option value="October">October</option>
    <option value="November">November</option>
    <option value="December">December</option>
  </select>
</label>

     <button
  type="button"
  className="btn primary"
  onClick={() => {
  if (!payrollMonth) {
    alert("Please select a payroll month first.");
    return;
  }

  setCreatedPayrollWorksheet({
  month: payrollMonth,
  created_at: new Date().toISOString(),
});

setOpenedPayrollWorksheetId(null);
setPayrollWorksheetEntries({});
}}
>
  Create Worksheet
</button>

    </div>
  </div>
</div>

{savedPayrollWorksheets.length > 0 && (
  <div
    className="paper section"
    style={{
      marginTop: 18,
      padding: 16,
      border: "1px solid #e5e7eb",
      background: "#fff",
    }}
  >
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
  <h3 style={{ marginTop: 0, marginBottom: 0 }}>Saved Worksheets</h3>

  <span
    style={{
      padding: "6px 10px",
      borderRadius: 999,
      background: "#f3f4f6",
      color: "#374151",
      fontSize: 12,
      fontWeight: 700,
    }}
  >
    {savedPayrollWorksheets.length} saved
  </span>
</div>

    <div style={{ display: "grid", gap: 8 }}>
      {savedPayrollWorksheets.map((ws) => (
        <div
          key={ws.id}
          style={{
            padding: 10,
            border: "1px solid #e5e7eb",
            borderRadius: 10,
            display: "flex",
            justifyContent: "space-between",
            gap: 10,
            flexWrap: "wrap",
          }}
        >
          <div>
            <b>{ws.month}</b>
            <div style={{ color: "#666", fontSize: 12 }}>
              Saved on {new Date(ws.saved_at).toLocaleString("en-IN")}
            </div>
          </div>

          <div style={{ display: "flex", gap: 8 }}>
  <button
    type="button"
    className="btn"
    onClick={() => {
      setCreatedPayrollWorksheet({
        month: ws.month,
        created_at: ws.saved_at,
      });

      setPayrollMonth(ws.month);
      setPayrollWorksheetEntries(ws.entries || {});
	setOpenedPayrollWorksheetId(ws.id);
    }}
  >
    Open
  </button>

  <button
    type="button"
    className="btn"
    onClick={() => {
      if (!window.confirm("Delete this saved worksheet?")) return;

      const updated = savedPayrollWorksheets.filter((x) => x.id !== ws.id);
      setSavedPayrollWorksheets(updated);
      localStorage.setItem("hvf.savedPayrollWorksheets", JSON.stringify(updated));
    }}
    style={{ color: "#dc2626" }}
  >
    Delete
  </button>
</div>
        </div>
      ))}
    </div>
  </div>
)}

{createdPayrollWorksheet ? (
  <div
    className="paper section"
    style={{
      marginTop: 18,
      padding: 18,
      border: "2px solid #dbeafe",
      background: "#f8fbff",
    }}
  >
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 12,
        flexWrap: "wrap",
      }}
    >
      <div>
        <h3 style={{ margin: 0 }}>
          Payroll Worksheet — {createdPayrollWorksheet.month}
        </h3>

        <div style={{ color: "#666", marginTop: 4, fontSize: 14 }}>
  Attendance & payroll preparation sheet
</div>

<div style={{ marginTop: 6, fontSize: 13, color: "#4b5563" }}>
  Employees in worksheet:{" "}
  <b>
    {
      payrollEmployees.filter((emp) =>
        payrollShowAll ? true : emp.type === payrollTab
      ).length
    }
  </b>
</div>

<div style={{ marginTop: 4, fontSize: 12, color: "#6b7280" }}>
  Last saved:{" "}
  {openedPayrollWorksheetId
    ? new Date(
        savedPayrollWorksheets.find((x) => x.id === openedPayrollWorksheetId)
          ?.saved_at || createdPayrollWorksheet.created_at
      ).toLocaleString("en-IN", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
})
    : "Not saved yet"}
</div>

<div style={{ marginTop: 8, color: "#374151", fontSize: 13 }}>
  <b>Payroll Period:</b>{" "}
  {(() => {
    const monthNames = [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ];

    const monthIndex = monthNames.indexOf(
      createdPayrollWorksheet?.month || payrollMonth
    );

    if (monthIndex === -1) {
      return payrollShowAll
        ? "Contractual: 1st to month-end • Non-contractual: 27th previous month to 26th selected month"
        : payrollTab === "contractual"
        ? "1st to last day of selected month"
        : "27th previous month to 26th selected month";
    }

    const selectedYear =
      Number(attendanceDate.slice(0, 4)) || new Date().getFullYear();

    const contractualDays = new Date(
      selectedYear,
      monthIndex + 1,
      0
    ).getDate();

    const nonContractualFrom = new Date(selectedYear, monthIndex - 1, 27);
    const nonContractualTo = new Date(selectedYear, monthIndex, 26);

    const nonContractualDays =
      Math.floor(
        (nonContractualTo - nonContractualFrom) / (1000 * 60 * 60 * 24)
      ) + 1;

    if (payrollShowAll) {
      return `Contractual: 1st to month-end (${contractualDays} days) • Non-contractual: 27th previous month to 26th selected month (${nonContractualDays} days)`;
    }

    return payrollTab === "contractual"
      ? `1st to last day of selected month (${contractualDays} days)`
      : `27th previous month to 26th selected month (${nonContractualDays} days)`;
  })()}
</div>

{(payrollTab === "contractual" || payrollShowAll) && (
  <div
    style={{
      marginTop: 6,
      color: "#b45309",
      fontSize: 12,
      fontWeight: 700,
    }}
  >
    Contractual payroll logic is temporary and will be finalized later.
  </div>
)}

      </div>

     <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
  <div
    style={{
      padding: "8px 12px",
      borderRadius: 999,
      background: "#dbeafe",
      color: "#1d4ed8",
      fontWeight: 700,
      fontSize: 13,
    }}
  >
    Active Worksheet
  </div>

  <button
    type="button"
    className="btn primary"
    onClick={() => {
      let updated = [];

if (openedPayrollWorksheetId) {
  updated = savedPayrollWorksheets.map((x) =>
    x.id === openedPayrollWorksheetId
      ? {
          ...x,
          month: createdPayrollWorksheet.month,
          entries: payrollWorksheetEntries,
          saved_at: new Date().toISOString(),
        }
      : x
  );

  alert("Worksheet updated ✅");
} else {
const alreadyExists = savedPayrollWorksheets.some(
  (x) => x.month === createdPayrollWorksheet.month
);

if (alreadyExists) {
  alert("A worksheet for this month already exists. Open and update it instead.");
  return;
}

  const newSavedWorksheet = {
    id: Date.now(),
    month: createdPayrollWorksheet.month,
    entries: payrollWorksheetEntries,
    saved_at: new Date().toISOString(),
  };

  updated = [...savedPayrollWorksheets, newSavedWorksheet];

  alert("Worksheet saved ✅");
}

setSavedPayrollWorksheets(updated);

localStorage.setItem(
  "hvf.savedPayrollWorksheets",
  JSON.stringify(updated)
);
    }}
  >
    {openedPayrollWorksheetId ? "Update Worksheet" : "Save Worksheet"}
  </button>

<button
  type="button"
  className="btn"
  onClick={() => {
    if (!createdPayrollWorksheet?.month) {
      alert("Please create/select a worksheet month first.");
      return;
    }

    const updatedEntries = { ...payrollWorksheetEntries };

    payrollEmployees.forEach((emp) => {
  const summary = buildAttendanceSummaryForEmployee(
    emp,
    createdPayrollWorksheet.month
  );

  const bonusDays = Number(
    calculateWeeklyBonusForEmployee(
      emp,
      summary.from,
      summary.to
    ) || 0
  );

  const basePayable =
  Number(summary.present || 0) +
  Number(summary.halfday || 0) * 0.5 +
  Number(summary.publicholiday || 0);

const finalPayable =
  emp.type === "non_contractual"
    ? basePayable + bonusDays
    : basePayable;

  updatedEntries[emp.id] = {
    ...(updatedEntries[emp.id] || {}),
    present: summary.present,
    absent: summary.absent,
    halfday: summary.halfday,
    weekoff: summary.weekoff,
    publicholiday: summary.publicholiday,
    bonus: bonusDays,
    payable: finalPayable,
    leave: summary.halfday,
  };
});

    setPayrollWorksheetEntries(updatedEntries);
    alert("Attendance loaded into worksheet ✅");
  }}
>
  Load Attendance
</button>

<button
  type="button"
  className="btn"
  onClick={() => {
    if (!window.confirm("Clear the active worksheet from screen? Saved worksheets will not be deleted.")) return;

    setCreatedPayrollWorksheet(null);
    setOpenedPayrollWorksheetId(null);
    setPayrollWorksheetEntries({});
  }}
>
  Clear
</button>

</div>
    </div>

<div
  style={{
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
    gap: 12,
    marginTop: 18,
    marginBottom: 18,
  }}
>
  <div className="paper section" style={{ padding: 14 }}>
    <div style={{ fontSize: 12, color: "#666" }}>Employees</div>
    <div style={{ fontSize: 24, fontWeight: 800 }}>
      {
        payrollEmployees.filter((emp) =>
          payrollShowAll ? true : emp.type === payrollTab
        ).length
      }
    </div>
  </div>

  <div className="paper section" style={{ padding: 14 }}>
    <div style={{ fontSize: 12, color: "#666" }}>Present Days</div>
    <div style={{ fontSize: 24, fontWeight: 800, color: "#166534" }}>
      {payrollEmployees
        .filter((emp) =>
          payrollShowAll ? true : emp.type === payrollTab
        )
        .reduce(
          (sum, emp) =>
            sum +
            Number(payrollWorksheetEntries[emp.id]?.present || 0),
          0
        )}
    </div>
  </div>

  {(() => {
    const totalPublicHoliday = payrollEmployees
      .filter((emp) =>
        payrollShowAll ? true : emp.type === payrollTab
      )
      .reduce(
        (sum, emp) =>
          sum +
          Number(payrollWorksheetEntries[emp.id]?.publicholiday || 0),
        0
      );

    if (totalPublicHoliday <= 0) return null;

    return (
      <div className="paper section" style={{ padding: 14 }}>
        <div style={{ fontSize: 12, color: "#666" }}>Public Holiday</div>
        <div style={{ fontSize: 24, fontWeight: 800, color: "#7c3aed" }}>
          {totalPublicHoliday}
        </div>
      </div>
    );
  })()}

  <div className="paper section" style={{ padding: 14 }}>
    <div style={{ fontSize: 12, color: "#666" }}>Bonus Days</div>
    <div style={{ fontSize: 24, fontWeight: 800, color: "#1d4ed8" }}>
      {payrollEmployees
        .filter((emp) =>
          payrollShowAll ? true : emp.type === payrollTab
        )
        .reduce(
          (sum, emp) =>
            sum +
            Number(payrollWorksheetEntries[emp.id]?.bonus || 0),
          0
        )}
    </div>
  </div>

<div className="paper section" style={{ padding: 14 }}>
  <div style={{ fontSize: 12, color: "#666" }}>Absent Days</div>

  <div style={{ fontSize: 24, fontWeight: 800, color: "#dc2626" }}>
    {payrollEmployees
      .filter((emp) =>
        payrollShowAll ? true : emp.type === payrollTab
      )
      .reduce(
        (sum, emp) =>
          sum + Number(payrollWorksheetEntries[emp.id]?.absent || 0),
        0
      )}
  </div>
</div>

<div className="paper section" style={{ padding: 14 }}>
  <div style={{ fontSize: 12, color: "#666" }}>
    Total Payable Before Advance
  </div>

  <div style={{ fontSize: 24, fontWeight: 800, color: "#047857" }}>
    ₹
    {Math.round(
      payrollEmployees
        .filter((emp) =>
          payrollShowAll ? true : emp.type === payrollTab
        )
        .reduce((sum, emp) => {
          const payrollMonthName =
            createdPayrollWorksheet?.month || payrollMonth;

          const startingBalance =
            emp.type === "non_contractual"
              ? getEmployeeStartingPayableBalanceForPayroll(
                  emp,
                  payrollMonthName
                )
              : null;

          const openingPayable = Number(
            startingBalance?.totalOpeningPayable || 0
          );

          const payableDays =
            Number(payrollWorksheetEntries[emp.id]?.present || 0) +
            Number(payrollWorksheetEntries[emp.id]?.leave || 0) * 0.5 +
            Number(payrollWorksheetEntries[emp.id]?.publicholiday || 0) +
            (emp.type === "non_contractual"
              ? Number(payrollWorksheetEntries[emp.id]?.bonus || 0)
              : 0);

          const currentPayable =
            emp.type === "non_contractual"
              ? (Number(emp.base_salary || 0) / 30) * payableDays
              : Number(emp.base_salary || 0);

          const payable =
            emp.type === "non_contractual"
              ? openingPayable + currentPayable
              : currentPayable;

          return sum + payable;
        }, 0)
    ).toLocaleString("en-IN")}
  </div>
</div>

<div className="paper section" style={{ padding: 14 }}>
  <div style={{ fontSize: 12, color: "#666" }}>Total Advance</div>

  <div style={{ fontSize: 24, fontWeight: 800, color: "#dc2626" }}>
    ₹
    {Math.round(
      payrollEmployees
        .filter((emp) =>
          payrollShowAll ? true : emp.type === payrollTab
        )
        .reduce(
          (sum, emp) =>
            sum +
            Number(
              getEmployeeAdvanceTotalForPayroll(
                emp,
                createdPayrollWorksheet?.month || payrollMonth
              ) || 0
            ),
          0
        )
    ).toLocaleString("en-IN")}
  </div>

  <div
    style={{
      marginTop: 4,
      fontSize: 11,
      color: "#6b7280",
      fontWeight: 600,
      lineHeight: 1.3,
    }}
  >
    Current payroll cycle only
  </div>
</div>

<div className="paper section" style={{ padding: 14 }}>
  <div style={{ fontSize: 12, color: "#666" }}>
    Previous Carry Forward
  </div>

  <div style={{ fontSize: 24, fontWeight: 800, color: "#dc2626" }}>
    {(() => {
      const totalCarryForward = payrollEmployees
        .filter((emp) =>
          payrollShowAll ? true : emp.type === payrollTab
        )
        .reduce(
          (sum, emp) =>
            sum +
            Number(
              getEmployeeCarryForwardBeforePayroll(
                emp,
                createdPayrollWorksheet?.month || payrollMonth
              ) || 0
            ),
          0
        );

      return (
        <>
          {totalCarryForward < 0 ? "−" : ""}₹
          {Math.abs(Math.round(totalCarryForward)).toLocaleString(
            "en-IN"
          )}
        </>
      );
    })()}
  </div>

  <div
    style={{
      marginTop: 4,
      fontSize: 11,
      color: "#6b7280",
      fontWeight: 600,
      lineHeight: 1.3,
    }}
  >
    From earlier negative balances only
  </div>
</div>

<div className="paper section" style={{ padding: 14 }}>
  <div style={{ fontSize: 12, color: "#666" }}>
    Final Payable Salary
  </div>

  {(() => {
    const finalTotal = payrollEmployees
      .filter((emp) =>
        payrollShowAll ? true : emp.type === payrollTab
      )
      .reduce((sum, emp) => {
        const payableDays =
          Number(payrollWorksheetEntries[emp.id]?.present || 0) +
          Number(payrollWorksheetEntries[emp.id]?.leave || 0) * 0.5 +
          Number(payrollWorksheetEntries[emp.id]?.publicholiday || 0) +
          (emp.type === "non_contractual"
            ? Number(payrollWorksheetEntries[emp.id]?.bonus || 0)
            : 0);

        const payrollMonthName =
          createdPayrollWorksheet?.month || payrollMonth;

        const startingBalance =
          emp.type === "non_contractual"
            ? getEmployeeStartingPayableBalanceForPayroll(
                emp,
                payrollMonthName
              )
            : null;

        const openingPayable = Number(
          startingBalance?.totalOpeningPayable || 0
        );

        const currentPayable =
          emp.type === "non_contractual"
            ? (Number(emp.base_salary || 0) / 30) * payableDays
            : Number(emp.base_salary || 0);

        const payableBeforeAdvance =
          emp.type === "non_contractual"
            ? openingPayable + currentPayable
            : currentPayable;

        const advanceTotal = Number(
          getEmployeeAdvanceTotalForPayroll(emp, payrollMonthName) || 0
        );

        const carryForwardBalance = Number(
          getEmployeeCarryForwardBeforePayroll(emp, payrollMonthName) || 0
        );

        return (
          sum +
          (payableBeforeAdvance + carryForwardBalance - advanceTotal)
        );
      }, 0);

    return (
      <>
        <div
          style={{
            fontSize: 24,
            fontWeight: 800,
            color: finalTotal < 0 ? "#dc2626" : "#166534",
          }}
        >
          {finalTotal < 0 ? "−" : ""}₹
          {Math.abs(Math.round(finalTotal)).toLocaleString("en-IN")}
        </div>

        <div
          style={{
            marginTop: 4,
            fontSize: 11,
            color: "#6b7280",
            fontWeight: 600,
            lineHeight: 1.3,
          }}
        >
          After deducting advance and previous carry-forward
        </div>
      </>
    );
  })()}
</div>

</div>

    <div
  style={{
    marginTop: 16,
    overflowX: "auto",
    WebkitOverflowScrolling: "touch",
    paddingBottom: 4,
  }}
>
     <table
  style={{
    width: "100%",
    borderCollapse: "collapse",
    minWidth: 1100,
  }}
>
        <thead>
          <tr
  style={{
    background: "#eef4ff",
    position: "sticky",
    top: 0,
    zIndex: 2,
  }}
>
	
<th style={{ padding: 10, textAlign: "center", width: 50 }}>No.</th>
<th style={{ padding: 10, textAlign: "left" }}>Employee</th>
<th style={{ padding: 10, textAlign: "left" }}>Type</th>
<th style={{ padding: 10, textAlign: "left" }}>Branch</th>
<th style={{ padding: 10, textAlign: "center" }}>Present</th>
<th style={{ padding: 10, textAlign: "center" }}>Half Day</th>

{(() => {
  const totalPublicHoliday = payrollEmployees
    .filter((emp) =>
      payrollShowAll ? true : emp.type === payrollTab
    )
    .reduce(
      (sum, emp) =>
        sum + Number(payrollWorksheetEntries[emp.id]?.publicholiday || 0),
      0
    );

  if (totalPublicHoliday <= 0) return null;

  return (
    <th style={{ padding: 10, textAlign: "center" }}>
      Public Holiday
    </th>
  );
})()}

<th style={{ padding: 10, textAlign: "center" }}>Absent</th>
<th style={{ padding: 10, textAlign: "center" }}>Bonus Days</th>
<th style={{ padding: 10, textAlign: "center" }}>Payable Days</th>
<th style={{ padding: 10, textAlign: "right" }}>Advance</th>
<th style={{ padding: 10, textAlign: "right" }}>
  Previous Carry Forward
</th>
<th style={{ padding: 10, textAlign: "right" }}>Per Day</th>
<th style={{ padding: 10, textAlign: "right" }}>Salary</th>
<th style={{ padding: 10, textAlign: "right" }}>
  Payable Before Advance
</th>
<th style={{ padding: 10, textAlign: "right" }}>
  Final Payable
</th>
</tr>
</thead>

<tbody>
  {payrollEmployees
    .filter((emp) => (payrollShowAll ? true : emp.type === payrollTab))
    .map((emp, index) => (
     
<tr
  key={emp.id}
  onMouseEnter={(e) => {
    e.currentTarget.style.background = "#f3f4f6";
  }}
  onMouseLeave={(e) => {
    e.currentTarget.style.background =
      index % 2 === 0 ? "#ffffff" : "#fafafa";
  }}
  onClick={(e) => {
    document.querySelectorAll(".payroll-row-active").forEach((row) => {
      row.classList.remove("payroll-row-active");
      row.style.boxShadow = "";
    });

    e.currentTarget.classList.add("payroll-row-active");
    e.currentTarget.style.boxShadow = "inset 4px 0 0 #2563eb";
  }}
  style={{
    borderTop: "1px solid #e5e7eb",
    background: index % 2 === 0 ? "#ffffff" : "#fafafa",
    transition: "background 0.15s ease",
    cursor: "pointer",
  }}
>
        <td style={{ padding: 10, textAlign: "center", fontWeight: 700 }}>
          {index + 1}
        </td>

        <td style={{ padding: 10 }}>
          <b>{emp.name}</b>
        </td>

        <td style={{ padding: 10 }}>
          {emp.type === "contractual" ? "Contractual" : "Non-contractual"}
        </td>

        <td style={{ padding: 10 }}>{emp.branch || "-"}</td>

        <td style={{ padding: 10, textAlign: "center" }}>
          <input
            type="number"
            min="0"
            placeholder="0"
            value={payrollWorksheetEntries[emp.id]?.present || ""}
            onChange={(e) =>
              setPayrollWorksheetEntries((prev) => ({
                ...prev,
                [emp.id]: {
                  ...(prev[emp.id] || {}),
                  present: e.target.value,
                },
              }))
            }
            style={{ width: 70, textAlign: "center" }}
          />
        </td>

               <td style={{ padding: 10, textAlign: "center" }}>
          <input
            type="number"
            min="0"
            placeholder="0"
            value={payrollWorksheetEntries[emp.id]?.leave || ""}
            onChange={(e) =>
              setPayrollWorksheetEntries((prev) => ({
                ...prev,
                [emp.id]: {
                  ...(prev[emp.id] || {}),
                  leave: e.target.value,
                },
              }))
            }
            style={{ width: 70, textAlign: "center" }}
          />
        </td>

        {(() => {
          const totalPublicHoliday = payrollEmployees
            .filter((employee) =>
              payrollShowAll ? true : employee.type === payrollTab
            )
            .reduce(
              (sum, employee) =>
                sum +
                Number(payrollWorksheetEntries[employee.id]?.publicholiday || 0),
              0
            );

          if (totalPublicHoliday <= 0) return null;

          return (
            <td
              style={{
                padding: 10,
                textAlign: "center",
                fontWeight: 700,
                color: "#7c3aed",
              }}
            >
              {Number(payrollWorksheetEntries[emp.id]?.publicholiday || 0)}
            </td>
          );
        })()}

        <td style={{ padding: 10, textAlign: "center", fontWeight: 700 }}>
          {Number(payrollWorksheetEntries[emp.id]?.absent || 0)}
        </td>

       <td style={{ padding: 10, textAlign: "center" }}>
  {emp.type === "non_contractual" ? (
    <input
      type="number"
      min="0"
      placeholder="0"
      value={payrollWorksheetEntries[emp.id]?.bonus || ""}
      onChange={(e) =>
        setPayrollWorksheetEntries((prev) => ({
          ...prev,
          [emp.id]: {
            ...(prev[emp.id] || {}),
            bonus: e.target.value,
          },
        }))
      }
      style={{ width: 70, textAlign: "center" }}
    />
  ) : (
    <span style={{ color: "#1d4ed8", fontWeight: 800 }}>
      {Number(payrollWorksheetEntries[emp.id]?.bonus || 0)}
    </span>
  )}
</td>

        <td style={{ padding: 10, textAlign: "center", fontWeight: 700 }}>
  {(
    Number(payrollWorksheetEntries[emp.id]?.present || 0) +
    Number(payrollWorksheetEntries[emp.id]?.leave || 0) * 0.5 +
    Number(payrollWorksheetEntries[emp.id]?.publicholiday || 0) +
    (emp.type === "non_contractual"
      ? Number(payrollWorksheetEntries[emp.id]?.bonus || 0)
      : 0)
  ).toFixed(1)}
</td>

<td
  style={{
    padding: 10,
    textAlign: "right",
    fontWeight: 800,
    color: "#dc2626",
  }}
>
  {(() => {
    const payrollMonthName =
      createdPayrollWorksheet?.month || payrollMonth;

    const advanceTotal = getEmployeeAdvanceTotalForPayroll(
      emp,
      payrollMonthName
    );

    const advanceEntries = getEmployeeAdvanceEntriesForPayroll(
      emp,
      payrollMonthName
    );

    return (
      <>
        <div>
          ₹
          {Math.round(advanceTotal).toLocaleString("en-IN")}
        </div>

        {advanceEntries.length > 0 && (
          <div
            style={{
              marginTop: 4,
              fontSize: 11,
              color: "#6b7280",
              fontWeight: 600,
              lineHeight: 1.35,
            }}
          >
            {advanceEntries.slice(0, 2).map((entry, index) => (
  <div
    key={`${entry.batchId}-${index}`}
    style={{ marginBottom: entry.remarks ? 4 : 0 }}
  >
    <div>
      {entry.advanceDate
        ? entry.advanceDate
            .split("-")
            .reverse()
            .join("-")
        : "—"}
      : ₹
      {Math.round(
        Number(entry.advanceAmount || 0)
      ).toLocaleString("en-IN")}{" "}
      {entry.paymentMode === "cash" ? "Cash" : "Online"}
    </div>

    {entry.remarks && (
      <div
        style={{
          marginTop: 2,
          color: "#92400e",
          fontSize: 10,
          fontWeight: 600,
        }}
      >
        {entry.remarks}
      </div>
    )}
  </div>
))}

            {advanceEntries.length > 2 && (
              <div>+{advanceEntries.length - 2} more advance(s)</div>
            )}
          </div>
        )}
      </>
    );
  })()}
</td>

<td
  style={{
    padding: 10,
    textAlign: "right",
    fontWeight: 800,
    color:
      getEmployeeCarryForwardBeforePayroll(
        emp,
        createdPayrollWorksheet?.month || payrollMonth
      ) < 0
        ? "#dc2626"
        : "#6b7280",
  }}
>
  {(() => {
    const carryForwardBalance =
      getEmployeeCarryForwardBeforePayroll(
        emp,
        createdPayrollWorksheet?.month || payrollMonth
      );

    return (
      <>
        <div>
          {carryForwardBalance < 0 ? "−" : ""}₹
          {Math.abs(
            Math.round(carryForwardBalance)
          ).toLocaleString("en-IN")}
        </div>

        {carryForwardBalance < 0 && (
          <div
            style={{
              marginTop: 4,
              fontSize: 11,
              color: "#dc2626",
              fontWeight: 600,
              lineHeight: 1.3,
            }}
          >
            From earlier cycle
          </div>
        )}
      </>
    );
  })()}
</td>

<td style={{ padding: 10, textAlign: "right" }}>
  ₹
  {Math.round(Number(emp.base_salary || 0) / 30).toLocaleString(
    "en-IN"
  )}
</td>

        <td style={{ padding: 10, textAlign: "right", fontWeight: 700 }}>
          ₹{Number(emp.base_salary || 0).toLocaleString("en-IN")}
        </td>

<td
  style={{
    padding: 10,
    textAlign: "right",
    fontWeight: 700,
  }}
>
  {emp.type === "non_contractual" ? (
    (() => {
      const payrollMonthName =
        createdPayrollWorksheet?.month || payrollMonth;

      const startingBalance =
        getEmployeeStartingPayableBalanceForPayroll(
          emp,
          payrollMonthName
        );

      const openingPayable = Number(
        startingBalance?.totalOpeningPayable || 0
      );

      const currentPayable =
        (Number(emp.base_salary || 0) / 30) *
        (
          Number(payrollWorksheetEntries[emp.id]?.present || 0) +
          Number(payrollWorksheetEntries[emp.id]?.leave || 0) * 0.5 +
          Number(payrollWorksheetEntries[emp.id]?.publicholiday || 0) +
          Number(payrollWorksheetEntries[emp.id]?.bonus || 0)
        );

      const payableBeforeAdvance =
        openingPayable + currentPayable;

      return (
        <div>
          <span
            style={{
              color:
                payableBeforeAdvance < 0
                  ? "#dc2626"
                  : payableBeforeAdvance <= 0
                  ? "#dc2626"
                  : payableBeforeAdvance < Number(emp.base_salary || 0) / 2
                  ? "#b45309"
                  : "#166534",
            }}
          >
            {payableBeforeAdvance < 0 ? "−" : ""}₹
            {Math.abs(
              Math.round(payableBeforeAdvance)
            ).toLocaleString("en-IN")}
          </span>

          {openingPayable !== 0 && (
            <div
              style={{
                marginTop: 4,
                fontSize: 11,
                color: "#1d4ed8",
                fontWeight: 700,
                lineHeight: 1.3,
              }}
            >
              Includes Starting{" "}
              {openingPayable < 0 ? "−" : ""}₹
              {Math.abs(
                Math.round(openingPayable)
              ).toLocaleString("en-IN")}
            </div>
          )}
        </div>
      );
    })()
  ) : (
    <span style={{ fontSize: 12 }}>To calculate later</span>
  )}
</td>

<td
  style={{
    padding: 10,
    textAlign: "right",
    fontWeight: 900,
  }}
>
  {emp.type === "non_contractual" ? (
    (() => {
      const payrollMonthName =
        createdPayrollWorksheet?.month || payrollMonth;

      const startingBalance =
        getEmployeeStartingPayableBalanceForPayroll(
          emp,
          payrollMonthName
        );

      const openingPayable = Number(
        startingBalance?.totalOpeningPayable || 0
      );

      const currentPayable =
        (Number(emp.base_salary || 0) / 30) *
        (
          Number(payrollWorksheetEntries[emp.id]?.present || 0) +
          Number(payrollWorksheetEntries[emp.id]?.leave || 0) * 0.5 +
          Number(payrollWorksheetEntries[emp.id]?.publicholiday || 0) +
          Number(payrollWorksheetEntries[emp.id]?.bonus || 0)
        );

      const payableBeforeAdvance =
        openingPayable + currentPayable;

      const advanceTotal = getEmployeeAdvanceTotalForPayroll(
        emp,
        payrollMonthName
      );

      const carryForwardBalance =
        getEmployeeCarryForwardBeforePayroll(
          emp,
          payrollMonthName
        );

      const finalPayable =
        payableBeforeAdvance + carryForwardBalance - advanceTotal;

      return (
        <div>
          <span
            style={{
              color: finalPayable < 0 ? "#dc2626" : "#166534",
            }}
          >
            {finalPayable < 0 ? "−" : ""}₹
            {Math.abs(
              Math.round(finalPayable)
            ).toLocaleString("en-IN")}
          </span>

          {(openingPayable !== 0 ||
            advanceTotal > 0 ||
            carryForwardBalance < 0) && (
            <div
              style={{
                marginTop: 4,
                fontSize: 11,
                color: "#6b7280",
                fontWeight: 600,
                lineHeight: 1.3,
              }}
            >
              After starting balance / advance / carry forward
            </div>
          )}
        </div>
      );
    })()
  ) : (
    <span style={{ fontSize: 12, color: "#777" }}>
      To calculate later
    </span>
  )}
</td>
      </tr>
    ))}


        </tbody>
      </table>
<div
  style={{
    marginTop: 14,
    padding: 12,
    background: "#f0fdf4",
    border: "1px solid #bbf7d0",
    borderRadius: 12,
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    flexWrap: "wrap",
  }}
>
  <div>
  <b>Final Payable After Advance</b>

  <div style={{ marginTop: 4, color: "#666", fontSize: 12, lineHeight: 1.5 }}>
    {(() => {
      const visiblePayrollEmployees = payrollEmployees.filter((emp) =>
        payrollShowAll ? true : emp.type === payrollTab
      );

      const presentTotal = visiblePayrollEmployees.reduce(
        (sum, emp) =>
          sum + Number(payrollWorksheetEntries[emp.id]?.present || 0),
        0
      );

      const halfDayTotal = visiblePayrollEmployees.reduce(
        (sum, emp) =>
          sum + Number(payrollWorksheetEntries[emp.id]?.leave || 0),
        0
      );

      const publicHolidayTotal = visiblePayrollEmployees.reduce(
        (sum, emp) =>
          sum + Number(payrollWorksheetEntries[emp.id]?.publicholiday || 0),
        0
      );

      const bonusTotal = visiblePayrollEmployees.reduce(
        (sum, emp) =>
          sum + Number(payrollWorksheetEntries[emp.id]?.bonus || 0),
        0
      );

      const advanceTotal = visiblePayrollEmployees.reduce(
        (sum, emp) =>
          sum +
          Number(
            getEmployeeAdvanceTotalForPayroll(
              emp,
              createdPayrollWorksheet?.month || payrollMonth
            ) || 0
          ),
        0
      );

      const carryForwardTotal = visiblePayrollEmployees.reduce(
        (sum, emp) =>
          sum +
          Number(
            getEmployeeCarryForwardBeforePayroll(
              emp,
              createdPayrollWorksheet?.month || payrollMonth
            ) || 0
          ),
        0
      );

      const startingBalanceTotal = visiblePayrollEmployees.reduce(
        (sum, emp) => {
          if (emp.type !== "non_contractual") return sum;

          const startingBalance =
            getEmployeeStartingPayableBalanceForPayroll(
              emp,
              createdPayrollWorksheet?.month || payrollMonth
            );

          return (
            sum + Number(startingBalance?.totalOpeningPayable || 0)
          );
        },
        0
      );

      return (
        <>
          Present: {presentTotal} days • Half Day: {halfDayTotal} days
          {publicHolidayTotal > 0 && (
            <> • PH: {publicHolidayTotal} days</>
          )}
          {" "}• Bonus: {bonusTotal} days
          <br />
          Starting Balance: {startingBalanceTotal < 0 ? "−" : ""}₹
          {Math.abs(Math.round(startingBalanceTotal)).toLocaleString("en-IN")}
          {" "}• Advance: ₹
          {Math.round(advanceTotal).toLocaleString("en-IN")} • Previous
          Carry Forward: {carryForwardTotal < 0 ? "−" : ""}₹
          {Math.abs(Math.round(carryForwardTotal)).toLocaleString("en-IN")}
        </>
      );
    })()}
  </div>
</div>

  {(() => {
    const finalTotal = payrollEmployees
      .filter((emp) => (payrollShowAll ? true : emp.type === payrollTab))
      .reduce((sum, emp) => {
        if (emp.type !== "non_contractual") return sum;

        const payableDays =
          Number(payrollWorksheetEntries[emp.id]?.present || 0) +
          Number(payrollWorksheetEntries[emp.id]?.leave || 0) * 0.5 +
          Number(payrollWorksheetEntries[emp.id]?.publicholiday || 0) +
          Number(payrollWorksheetEntries[emp.id]?.bonus || 0);

        const payrollMonthName =
          createdPayrollWorksheet?.month || payrollMonth;

        const startingBalance =
          getEmployeeStartingPayableBalanceForPayroll(
            emp,
            payrollMonthName
          );

        const openingPayable = Number(
          startingBalance?.totalOpeningPayable || 0
        );

        const currentPayable =
          (Number(emp.base_salary || 0) / 30) * payableDays;

        const payableBeforeAdvance =
          openingPayable + currentPayable;

        const advanceTotal = Number(
          getEmployeeAdvanceTotalForPayroll(emp, payrollMonthName) || 0
        );

        const carryForwardBalance = Number(
          getEmployeeCarryForwardBeforePayroll(emp, payrollMonthName) || 0
        );

        const finalPayable =
          payableBeforeAdvance + carryForwardBalance - advanceTotal;


        return sum + finalPayable;
      }, 0);

    return (
      <b
        style={{
          color: finalTotal < 0 ? "#dc2626" : "#166534",
          fontSize: 18,
        }}
      >
        {finalTotal < 0 ? "−" : ""}₹
        {Math.abs(Math.round(finalTotal)).toLocaleString("en-IN")}
      </b>
    );
  })()}
</div>
    </div>
  </div>
) : (
  <div
    className="paper section"
    style={{
      marginTop: 18,
      padding: 24,
      textAlign: "center",
      color: "#666",
      border: "1px dashed #d1d5db",
      background: "#fafafa",
    }}
  >
    No active worksheet selected.
    <div style={{ marginTop: 6, fontSize: 13 }}>
      Select a month and click “Create Worksheet”.
    </div>
  </div>
)}

{selectedPayrollEmployee && (
  <div
    className="paper section"
    style={{
      marginTop: 18,
      padding: 16,
      border: "1px solid #e5e7eb",
      background: "#f9fafb",
    }}
  >
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
      <div>
        <h3 style={{ margin: 0 }}>{selectedPayrollEmployee.name}</h3>
        <p style={{ margin: "6px 0 0", color: "#666" }}>
          {selectedPayrollEmployee.type === "contractual"
            ? "Contractual Employee"
            : "Non-contractual Employee"}
        </p>
      </div>

      <button className="btn" onClick={() => setSelectedPayrollEmployee(null)}>
        Close
      </button>
    </div>

    <div
      style={{
        marginTop: 14,
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
        gap: 10,
      }}
    >
      <div><b>Phone:</b> {selectedPayrollEmployee.phone || "-"}</div>
      <div><b>Designation:</b> {selectedPayrollEmployee.designation || "-"}</div>
      <div><b>Branch:</b> {selectedPayrollEmployee.branch || "-"}</div>
      <div><b>Base Salary:</b> ₹{Number(selectedPayrollEmployee.base_salary || 0).toLocaleString("en-IN")}</div>
      <div><b>DOB:</b> {selectedPayrollEmployee.dob || "-"}</div>
      <div><b>Joining:</b> {selectedPayrollEmployee.joining_date || "-"}</div>
      <div style={{ gridColumn: "1 / -1" }}>
        <b>Address:</b> {selectedPayrollEmployee.address || "-"}
      </div>
    </div>
  </div>
)}

<div
  style={{
    marginTop: 18,
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
    gap: 10,
  }}
>
  <div className="paper section" style={{ padding: 12 }}>
    <div style={{ color: "#666", fontSize: 12 }}>Total Employees</div>
    <div style={{ fontSize: 22, fontWeight: 800 }}>
      {payrollEmployees.length}
    </div>
  </div>

  <div className="paper section" style={{ padding: 12 }}>
    <div style={{ color: "#666", fontSize: 12 }}>Contractual</div>
    <div style={{ fontSize: 22, fontWeight: 800 }}>
      {payrollEmployees.filter((e) => e.type === "contractual").length}
    </div>
  </div>

  <div className="paper section" style={{ padding: 12 }}>
    <div style={{ color: "#666", fontSize: 12 }}>Non-contractual</div>
    <div style={{ fontSize: 22, fontWeight: 800 }}>
      {payrollEmployees.filter((e) => e.type === "non_contractual").length}
    </div>
  </div>
</div>

      <div style={{ marginTop: 20 }}>
  {payrollEmployees.length === 0 ? (
    <p style={{ color: "#777" }}>No employees added yet.</p>
  ) : (
    <div style={{ display: "grid", gap: 10 }}>
      {payrollEmployees
        .filter((emp) =>
          payrollShowAll ? true : emp.type === payrollTab
        )
        .map((emp) => (
          <div
  key={emp.id}
  className="paper section"
  style={{
    padding: 12,
    border: "1px solid #e5e7eb",
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    alignItems: "center",
    flexWrap: "wrap",
    background: (emp.status || "active") === "left" ? "#f3f4f6" : "#fff",
    opacity: (emp.status || "active") === "left" ? 0.72 : 1,
  }}
>


<div style={{ display: "flex", gap: 14, alignItems: "center" }}>
  <div
    style={{
      width: 42,
      height: 42,
      borderRadius: 12,
      background: "#2563eb",
      color: "#fff",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      fontWeight: 800,
      fontSize: 14,
    }}
  >
    {emp.id.toString().slice(-2)}
  </div>

  <div>
    <b style={{ fontSize: 16 }}>{emp.name}</b>

    <div style={{ color: "#666", fontSize: 13, marginTop: 2 }}>
      {emp.designation || "Staff"} • {emp.branch || "Branch not set"}
    </div>

    <div style={{ color: "#777", fontSize: 12, marginTop: 2 }}>
      {emp.type === "contractual" ? "Contractual" : "Non-contractual"}
    </div>

    <div style={{ color: "#888", fontSize: 12, marginTop: 4 }}>
      Joined: {emp.joining_date || "Not entered"}
    </div>
  </div>
</div>


            <div style={{ textAlign: "right" }}>
  <div style={{ fontWeight: 800, fontSize: 20 }}>
    ₹{Number(emp.base_salary || 0).toLocaleString("en-IN")}
  </div>

  <div style={{ display: "flex", gap: 8, marginTop: 8, justifyContent: "flex-end" }}>
  <button
    type="button"
    className="btn"
    onClick={() => setSelectedPayrollEmployee(emp)}
  >
    View Details
  </button>

  <button
    type="button"
    className="btn"
    onClick={() => {
      setEditingPayrollEmployeeId(emp.id);
     setEmployeeForm({
  type: emp.type || "contractual",
  name: emp.name || "",
  dob: emp.dob || "",
  address: emp.address || "",
  joining_date: emp.joining_date || "",
  base_salary: emp.base_salary || "",
  phone: emp.phone || "",
  designation: emp.designation || "",
  branch: emp.branch || "",
  weekly_off: emp.weekly_off || "sunday",
  status: emp.status || "active",
});
      setShowEmployeeForm(true);

setTimeout(() => {
  employeeFormRef.current?.scrollIntoView({
    behavior: "smooth",
    block: "start",
  });
}, 100);
    }}
  >
    Edit
  </button>

<button
  type="button"
  className="btn"
  onClick={() => {
    if (!window.confirm(`Delete employee "${emp.name}"?`)) return;

    const updatedEmployees = payrollEmployees.filter((x) => x.id !== emp.id);

    setPayrollEmployees(updatedEmployees);
	if (selectedPayrollEmployee?.id === emp.id) {
  setSelectedPayrollEmployee(null);
}
    localStorage.setItem(
      "hvf.payrollEmployees",
      JSON.stringify(updatedEmployees)
    );

    if (selectedPayrollEmployee?.id === emp.id) {
      setSelectedPayrollEmployee(null);
    }
  }}
  style={{ color: "#dc2626" }}
>
  Delete
</button>

</div>

</div>
          </div>
        ))}
    </div>
  )}
</div>
    </div>
  </div>
)}

{page === "advance" && (
  <div style={{ maxWidth: 1160, margin: "0 auto 40px", padding: "0 12px" }}>
    <div className="paper section" style={{ padding: 20 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 12,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <div>
          <h1 style={{ margin: 0 }}>Advance Payment</h1>

          <p style={{ color: "#666", marginTop: 6 }}>
            Calculate payable till date and record employee advances.
          </p>
        </div>

       <div
  style={{
    display: "flex",
    gap: 8,
    flexWrap: "wrap",
    justifyContent: "flex-end",
  }}
>
  <button
    type="button"
    className="btn"
    onClick={downloadPayrollLocalStorageBackup}
    style={{
      background: "#166534",
      color: "#ffffff",
      border: "none",
      fontWeight: 800,
    }}
  >
    Backup Data
  </button>

  <button
    type="button"
    className="btn"
    onClick={restorePayrollLocalStorageBackup}
    style={{
      background: "#f59e0b",
      color: "#111827",
      border: "none",
      fontWeight: 800,
    }}
  >
    Restore Data
  </button>

  <button
    type="button"
    className="btn"
    onClick={backToCatalog}
  >
    ← Back to Catalog
  </button>
</div>
      </div>
    </div>

    <div
      className="paper section"
      style={{ padding: 20, marginTop: 16 }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-end",
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        <div>
          <h3 style={{ margin: "0 0 12px" }}>
            Employee Payable Till Date
          </h3>

          <div
            style={{
              display: "flex",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            {[
              ["contractual", "Contractual"],
              ["non_contractual", "Non-contractual"],
              ["all", "All Employees"],
            ].map(([value, label]) => (
              <button
                key={value}
                type="button"
                className="btn"
                onClick={() => {
                  setAdvanceTab(value);
                  setSelectedAdvanceEmployeeIds([]);
                  setShowAdvanceGenerator(false);
                }}
                style={{
                  background:
                    advanceTab === value ? "#b45309" : "#f3f4f6",
                  color: advanceTab === value ? "#fff" : "#111827",
                  border:
                    advanceTab === value
                      ? "1px solid #b45309"
                      : "1px solid #d1d5db",
                  fontWeight: 700,
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <label
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            fontWeight: 700,
          }}
        >
          Payable Till Date

          <input
            type="date"
            value={advanceDate}
            onChange={(e) => {
              setAdvanceDate(e.target.value);
              setSelectedAdvanceEmployeeIds([]);
              setShowAdvanceGenerator(false);
            }}
            style={{
              padding: "9px 10px",
              border: "1px solid #d1d5db",
              borderRadius: 8,
              fontSize: 14,
            }}
          />
        </label>

        <label
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            fontWeight: 700,
            minWidth: 220,
          }}
        >
          Search Employee

          <div
            style={{
              display: "flex",
              gap: 6,
              alignItems: "center",
            }}
          >
            <input
              type="text"
              value={advanceEmployeeSearch}
              onChange={(e) => {
  setAdvanceEmployeeSearch(e.target.value);
  setShowAdvanceGenerator(false);
}}
              placeholder="Name / branch / type"
              style={{
                padding: "9px 10px",
                border: "1px solid #d1d5db",
                borderRadius: 8,
                fontSize: 14,
                flex: 1,
              }}
            />

            {advanceEmployeeSearch.trim() && (
              <button
                type="button"
                className="btn"
                onClick={() => {
  setAdvanceEmployeeSearch("");
  setShowAdvanceGenerator(false);
}}
                style={{
                  background: "#f3f4f6",
                  color: "#111827",
                  border: "1px solid #d1d5db",
                  fontWeight: 700,
                  padding: "9px 10px",
                }}
              >
                Clear
              </button>
            )}
          </div>
        </label>
      </div>

      <div
        style={{
          marginTop: 20,
          padding: 16,
          border: "1px solid #d1d5db",
          borderRadius: 10,
          background: "#f9fafb",
        }}
      >
        <h3 style={{ margin: "0 0 14px" }}>
          Historical Advance Import
        </h3>

        <div
          style={{
            display: "flex",
            gap: 12,
            flexWrap: "wrap",
            alignItems: "flex-end",
          }}
        >
          <label
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
              fontWeight: 700,
            }}
          >
            From Date
            <input
              type="date"
              value={historicalAdvanceFromDate}
              onChange={(e) =>
                setHistoricalAdvanceFromDate(e.target.value)
              }
              style={{
                padding: "9px 10px",
                border: "1px solid #d1d5db",
                borderRadius: 8,
              }}
            />
          </label>

          <label
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
              fontWeight: 700,
            }}
          >
            To Date
            <input
              type="date"
              value={historicalAdvanceToDate}
              onChange={(e) =>
                setHistoricalAdvanceToDate(e.target.value)
              }
              style={{
                padding: "9px 10px",
                border: "1px solid #d1d5db",
                borderRadius: 8,
              }}
            />
          </label>

          <label
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
              fontWeight: 700,
            }}
          >
            Employee Type

            <select
              value={historicalAdvanceEmployeeType}
              onChange={(e) =>
                setHistoricalAdvanceEmployeeType(e.target.value)
              }
              style={{
                padding: "9px 10px",
                border: "1px solid #d1d5db",
                borderRadius: 8,
                minWidth: 180,
              }}
            >
              <option value="non_contractual">
                Non-contractual
              </option>

              <option value="contractual">
                Contractual
              </option>
            </select>
          </label>

          <button
  type="button"
  className="btn"
  onClick={generateHistoricalAdvanceTemplate}
>
  Generate Template
</button>

<button
  type="button"
  className="btn"
  onClick={() =>
    historicalAdvanceImportInputRef.current?.click()
  }
>
  Upload Template
</button>

<input
  ref={historicalAdvanceImportInputRef}
  type="file"
  accept=".xlsx,.xls"
  style={{ display: "none" }}
  onChange={handleHistoricalAdvanceTemplateUpload}
/> 
        </div>
      </div>

      {showHistoricalAdvanceConfirmDialog &&
        parsedHistoricalAdvanceSummary && (
          <div
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 9999,
              background: "rgba(17, 24, 39, 0.65)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 20,
            }}
          >
            <div
              style={{
                width: "100%",
                maxWidth: 520,
                background: "#ffffff",
                borderRadius: 14,
                padding: 22,
                boxShadow: "0 24px 60px rgba(0, 0, 0, 0.28)",
              }}
            >
              <h3
                style={{
                  margin: 0,
                  color: "#111827",
                }}
              >
                Confirm Historical Advance Import
              </h3>

              <div
                style={{
                  marginTop: 8,
                  color: "#4b5563",
                  fontSize: 13,
                  lineHeight: 1.5,
                }}
              >
                Please verify the imported advance summary before
                continuing.
              </div>

              <div
                style={{
                  marginTop: 18,
                  padding: 14,
                  borderRadius: 10,
                  background: "#f9fafb",
                  border: "1px solid #e5e7eb",
                  display: "grid",
                  gap: 10,
                }}
              >
                <div>
                  Employee Type:{" "}
                  <b>
                    {historicalAdvanceEmployeeType === "contractual"
                      ? "Contractual"
                      : "Non-contractual"}
                  </b>
                </div>

                <div>
                  Import Period:{" "}
                  <b>
                    {historicalAdvanceFromDate
                      ?.split("-")
                      .reverse()
                      .join("-")}{" "}
                    to{" "}
                    {historicalAdvanceToDate
                      ?.split("-")
                      .reverse()
                      .join("-")}
                  </b>
                </div>

                <div>
                  Employees Affected:{" "}
                  <b>
                    {parsedHistoricalAdvanceSummary.employeeCount}
                  </b>
                </div>

                <div>
                  Regular Advances:{" "}
                  <b>
                    {parsedHistoricalAdvanceSummary.regularCount}
                  </b>
                </div>

                <div>
                  Other-Date Advances:{" "}
                  <b>
                    {parsedHistoricalAdvanceSummary.otherCount}
                  </b>
                </div>

                <div>
                  Total Records:{" "}
                  <b>{parsedHistoricalAdvanceSummary.totalCount}</b>
                </div>

                <div
                  style={{
                    paddingTop: 10,
                    borderTop: "1px solid #d1d5db",
                    fontSize: 18,
                    color: "#166534",
                  }}
                >
                  Total Advance Amount:{" "}
                  <b>
                    ₹
                    {Number(
                      parsedHistoricalAdvanceSummary.totalAmount || 0
                    ).toLocaleString("en-IN")}
                  </b>
                </div>
              </div>

              <div
                style={{
                  marginTop: 14,
                  padding: "10px 12px",
                  borderRadius: 8,
                  background: "#fffbeb",
                  border: "1px solid #fde68a",
                  color: "#92400e",
                  fontSize: 12,
                  fontWeight: 700,
                  lineHeight: 1.5,
                }}
              >
                Nothing has been saved yet. Please confirm only after
                checking the imported details.
              </div>

              <div
                style={{
                  marginTop: 20,
                  display: "flex",
                  justifyContent: "flex-end",
                  gap: 10,
                  flexWrap: "wrap",
                }}
              >
                <button
                  type="button"
                  className="btn"
                  onClick={() =>
                    setShowHistoricalAdvanceConfirmDialog(false)
                  }
                >
                  Cancel
                </button>

                <button
  type="button"
  className="btn"
  onClick={saveParsedHistoricalAdvances}
  style={{
    background: "#166534",
    color: "#ffffff",
    border: "none",
    fontWeight: 800,
  }}
>
  Confirm Import
</button>
              </div>
            </div>
          </div>
        )}

      <div
        style={{
          marginTop: 20,
          padding: 16,
          border: "1px solid #d1d5db",
          borderRadius: 10,
          background: "#f9fafb",
        }}
      >
        <h3 style={{ margin: "0 0 14px" }}>
          Historical Salary Payment Import
        </h3>

        <div
          style={{
            display: "flex",
            gap: 12,
            flexWrap: "wrap",
            alignItems: "flex-end",
          }}
        >
          <label
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
              fontWeight: 700,
            }}
          >
            From Date

            <input
              type="date"
              value={historicalSalaryPaymentFromDate}
              onChange={(e) =>
                setHistoricalSalaryPaymentFromDate(e.target.value)
              }
              style={{
                padding: "9px 10px",
                border: "1px solid #d1d5db",
                borderRadius: 8,
              }}
            />
          </label>

          <label
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
              fontWeight: 700,
            }}
          >
            To Date

            <input
              type="date"
              value={historicalSalaryPaymentToDate}
              onChange={(e) =>
                setHistoricalSalaryPaymentToDate(e.target.value)
              }
              style={{
                padding: "9px 10px",
                border: "1px solid #d1d5db",
                borderRadius: 8,
              }}
            />
          </label>

          <label
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
              fontWeight: 700,
            }}
          >
            Employee Type

            <select
              value={historicalSalaryPaymentEmployeeType}
              onChange={(e) =>
                setHistoricalSalaryPaymentEmployeeType(
                  e.target.value
                )
              }
              style={{
                padding: "9px 10px",
                border: "1px solid #d1d5db",
                borderRadius: 8,
                minWidth: 180,
              }}
            >
              <option value="non_contractual">
                Non-contractual
              </option>

              <option value="contractual">
                Contractual
              </option>
            </select>
          </label>

                    <button
            type="button"
            className="btn"
            onClick={generateHistoricalSalaryPaymentTemplate}
          >
            Generate Template
          </button>

          <button
            type="button"
            className="btn"
            onClick={() =>
              historicalSalaryPaymentImportInputRef.current?.click()
            }
          >
            Upload Template
          </button>

                    <input
            ref={historicalSalaryPaymentImportInputRef}
            type="file"
            accept=".xlsx,.xls"
            style={{ display: "none" }}
            onChange={handleHistoricalSalaryPaymentTemplateUpload}
          />
        </div>
      </div>

      {showHistoricalSalaryPaymentConfirmDialog &&
        parsedHistoricalSalaryPaymentSummary && (
          <div
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 9999,
              background: "rgba(17, 24, 39, 0.65)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 20,
            }}
          >
            <div
              style={{
                width: "100%",
                maxWidth: 540,
                background: "#ffffff",
                borderRadius: 14,
                padding: 22,
                boxShadow: "0 24px 60px rgba(0, 0, 0, 0.28)",
              }}
            >
              <h3
                style={{
                  margin: 0,
                  color: "#111827",
                }}
              >
                Confirm Historical Salary Payment Import
              </h3>

              <div
                style={{
                  marginTop: 8,
                  color: "#4b5563",
                  fontSize: 13,
                  lineHeight: 1.5,
                }}
              >
                Please verify the imported salary payment summary
                before continuing.
              </div>

              <div
                style={{
                  marginTop: 18,
                  padding: 14,
                  borderRadius: 10,
                  background: "#f9fafb",
                  border: "1px solid #e5e7eb",
                  display: "grid",
                  gap: 10,
                }}
              >
                <div>
                  Employee Type:{" "}
                  <b>
                    {historicalSalaryPaymentEmployeeType ===
                    "contractual"
                      ? "Contractual"
                      : "Non-contractual"}
                  </b>
                </div>

                <div>
                  Import Period:{" "}
                  <b>
                    {historicalSalaryPaymentFromDate
                      ?.split("-")
                      .reverse()
                      .join("-")}{" "}
                    to{" "}
                    {historicalSalaryPaymentToDate
                      ?.split("-")
                      .reverse()
                      .join("-")}
                  </b>
                </div>

                <div>
                  Employees Affected:{" "}
                  <b>
                    {
                      parsedHistoricalSalaryPaymentSummary.employeeCount
                    }
                  </b>
                </div>

                <div>
                  Salary Payments Found:{" "}
                  <b>
                    {
                      parsedHistoricalSalaryPaymentSummary.paymentCount
                    }
                  </b>
                </div>

                <div>
                  Cash Payments:{" "}
                  <b>
                    {
                      parsedHistoricalSalaryPaymentSummary.cashCount
                    }
                  </b>
                </div>

                <div>
                  Online Payments:{" "}
                  <b>
                    {
                      parsedHistoricalSalaryPaymentSummary.onlineCount
                    }
                  </b>
                </div>

                <div>
                  Total Cash Amount:{" "}
                  <b>
                    ₹
                    {Number(
                      parsedHistoricalSalaryPaymentSummary.cashAmount ||
                        0
                    ).toLocaleString("en-IN")}
                  </b>
                </div>

                <div>
                  Total Online Amount:{" "}
                  <b>
                    ₹
                    {Number(
                      parsedHistoricalSalaryPaymentSummary.onlineAmount ||
                        0
                    ).toLocaleString("en-IN")}
                  </b>
                </div>

                <div
                  style={{
                    paddingTop: 10,
                    borderTop: "1px solid #d1d5db",
                    fontSize: 18,
                    color: "#166534",
                  }}
                >
                  Total Salary Paid:{" "}
                  <b>
                    ₹
                    {Number(
                      parsedHistoricalSalaryPaymentSummary.totalAmount ||
                        0
                    ).toLocaleString("en-IN")}
                  </b>
                </div>
              </div>

              <div
                style={{
                  marginTop: 14,
                  padding: "10px 12px",
                  borderRadius: 8,
                  background: "#fffbeb",
                  border: "1px solid #fde68a",
                  color: "#92400e",
                  fontSize: 12,
                  fontWeight: 700,
                  lineHeight: 1.5,
                }}
              >
                Nothing has been saved yet. Please verify the
                payment periods, payment dates and amounts before
                confirming.
              </div>

              <div
                style={{
                  marginTop: 20,
                  display: "flex",
                  justifyContent: "flex-end",
                  gap: 10,
                  flexWrap: "wrap",
                }}
              >
                <button
                  type="button"
                  className="btn"
                  onClick={() =>
                    setShowHistoricalSalaryPaymentConfirmDialog(
                      false
                    )
                  }
                >
                  Cancel
                </button>

                <button
  type="button"
  className="btn"
  onClick={saveParsedHistoricalSalaryPayments}
  style={{
    background: "#166534",
    color: "#ffffff",
    border: "none",
    fontWeight: 800,
  }}
>
  Confirm Import
</button>
              </div>
            </div>
          </div>
        )}

{showHistoricalSalaryPaymentSummaryDialog &&
  selectedHistoricalSalaryPaymentBatch && (
    <HistoricalSalaryPaymentSummaryDialog
      batch={selectedHistoricalSalaryPaymentBatch}
      onClose={() => {
        setShowHistoricalSalaryPaymentSummaryDialog(false);
        setSelectedHistoricalSalaryPaymentBatch(null);
      }}
    />
)}


{showHistoricalSalaryPaymentExpandDialog &&
  selectedExpandedHistoricalSalaryPaymentBatch && (
   <HistoricalSalaryPaymentExpandDialog
  batch={selectedExpandedHistoricalSalaryPaymentBatch}
  onClose={() => {
    setShowHistoricalSalaryPaymentExpandDialog(false);
    setSelectedExpandedHistoricalSalaryPaymentBatch(null);
  }}
onEditPayment={(
  batchId,
  paymentIndex,
  payment
) => {
  setSelectedEditHistoricalSalaryPayment({
    batchId,
    paymentIndex,
    payment,
  });

  setShowHistoricalSalaryPaymentEditDialog(true);
}}
  onDeletePayment={(
        batchId,
        paymentIndex,
        payment
      ) => {
        const confirmed = window.confirm(
          `Delete the salary payment of ₹${Math.round(
            Number(payment.amount || 0)
          ).toLocaleString("en-IN")} for ${
            payment.employeeName || "this employee"
          }?\n\nThis action cannot be undone.`
        );

        if (!confirmed) {
          return;
        }

        setSavedHistoricalSalaryPaymentBatches(
          (previous) =>
            previous
              .map((savedBatch) => {
                if (savedBatch.id !== batchId) {
                  return savedBatch;
                }

                return {
                  ...savedBatch,
                  payments: (
                    savedBatch.payments || []
                  ).filter(
                    (_, savedPaymentIndex) =>
                      savedPaymentIndex !== paymentIndex
                  ),
                };
              })
              .filter(
                (savedBatch) =>
                  (savedBatch.payments || []).length > 0
              )
        );

        setSelectedExpandedHistoricalSalaryPaymentBatch(
          (currentBatch) => {
            if (!currentBatch || currentBatch.id !== batchId) {
              return currentBatch;
            }

            const updatedPayments = (
              currentBatch.payments || []
            ).filter(
              (_, savedPaymentIndex) =>
                savedPaymentIndex !== paymentIndex
            );

            if (!updatedPayments.length) {
              setShowHistoricalSalaryPaymentExpandDialog(false);
              return null;
            }

            return {
              ...currentBatch,
              payments: updatedPayments,
            };
          }
        );
      }}
    />
)}

{showHistoricalSalaryPaymentEditDialog &&
  selectedEditHistoricalSalaryPayment && (
    <HistoricalSalaryPaymentEditDialog
      editInfo={selectedEditHistoricalSalaryPayment}
      onClose={() => {
        setShowHistoricalSalaryPaymentEditDialog(false);
        setSelectedEditHistoricalSalaryPayment(null);
      }}
      onSave={(updatedPayment) => {
        const { batchId, paymentIndex } =
          selectedEditHistoricalSalaryPayment;

        setSavedHistoricalSalaryPaymentBatches(
          (previous) =>
            previous.map((savedBatch) => {
              if (savedBatch.id !== batchId) {
                return savedBatch;
              }

              const updatedPayments = (
                savedBatch.payments || []
              ).map((payment, index) =>
                index === paymentIndex
                  ? updatedPayment
                  : payment
              );

              return {
                ...savedBatch,
                paymentDate:
                  updatedPayment.paymentDate,
                payments: updatedPayments,
              };
            })
        );

        setSelectedExpandedHistoricalSalaryPaymentBatch(
          (currentBatch) => {
            if (
              !currentBatch ||
              currentBatch.id !== batchId
            ) {
              return currentBatch;
            }

            const updatedPayments = (
              currentBatch.payments || []
            ).map((payment, index) =>
              index === paymentIndex
                ? updatedPayment
                : payment
            );

            return {
              ...currentBatch,
              paymentDate:
                updatedPayment.paymentDate,
              payments: updatedPayments,
            };
          }
        );

        setShowHistoricalSalaryPaymentEditDialog(false);
        setSelectedEditHistoricalSalaryPayment(null);
      }}
    />
)}

      {selectedAdvanceEmployeeIds.length > 0 && (

        <div
          style={{
            marginTop: 12,
            padding: "10px 12px",
            borderRadius: 8,
            background: "#eff6ff",
            border: "1px solid #bfdbfe",
            color: "#1e3a8a",
            fontSize: 13,
            fontWeight: 700,
            lineHeight: 1.5,
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 10,
              flexWrap: "wrap",
            }}
          >
            <span>
              Selected for advance: {selectedAdvanceEmployeeIds.length}
            </span>

            <button
              type="button"
              onClick={() => {
                setSelectedAdvanceEmployeeIds([]);
                setShowAdvanceGenerator(false);
              }}
              style={{
                border: "1px solid #bfdbfe",
                background: "#ffffff",
                color: "#dc2626",
                borderRadius: 999,
                padding: "4px 10px",
                fontSize: 12,
                fontWeight: 800,
                cursor: "pointer",
              }}
            >
              Clear selected
            </button>
          </div>

          <div
            style={{
              marginTop: 6,
              display: "flex",
              gap: 6,
              flexWrap: "wrap",
            }}
          >
            {selectedAdvanceEmployeeIds.map((employeeId) => {
              const selectedEmployee = payrollEmployees.find(
                (emp) => String(emp.id) === String(employeeId)
              );

              if (!selectedEmployee) return null;

              return (
                <span
                  key={employeeId}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "4px 8px",
                    borderRadius: 999,
                    background: "#ffffff",
                    border: "1px solid #93c5fd",
                    color: "#1e40af",
                    fontSize: 12,
                    fontWeight: 700,
                  }}
                >
                  {selectedEmployee.name}
                  <button
                    type="button"
                    onClick={() =>
                      setSelectedAdvanceEmployeeIds((previous) =>
                        previous.filter(
                          (id) => String(id) !== String(employeeId)
                        )
                      )
                    }
                    style={{
                      border: "none",
                      background: "transparent",
                      color: "#dc2626",
                      cursor: "pointer",
                      fontWeight: 900,
                      padding: 0,
                    }}
                  >
                    ×
                  </button>
                </span>
              );
            })}
          </div>
        </div>
      )}

      <>

        <div
          style={{
            marginTop: 16,
            padding: "10px 12px",
            borderRadius: 8,
            background: "#f9fafb",
            border: "1px solid #e5e7eb",
            color: "#374151",
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          {(() => {
            if (!advanceDate) {
              return "Select a date to view the advance payable cycle.";
            }

            const formatDate = (dateValue) =>
              dateValue
                ? dateValue.split("-").reverse().join("-")
                : "—";

            const [year, month, day] = advanceDate
              .split("-")
              .map(Number);

            if (advanceTab === "contractual") {
              const fromDate = `${year}-${String(month).padStart(
                2,
                "0"
              )}-01`;

              const toDate = getLocalDateKey(
                new Date(year, month, 0)
              );

return (
  <>
    <b>Advance Cycle:</b> {formatDate(fromDate)} to{" "}
    {formatDate(toDate)}
    {"  "}•{"  "}
    <b>Payable calculated up to:</b>{" "}
    {formatDate(advanceDate)}
    <div
      style={{
        marginTop: 6,
        color: "#b45309",
        fontSize: 12,
        fontWeight: 700,
      }}
    >
      Contractual payable logic is temporary and will be finalized later.
    </div>
  </>
);
            }

            if (advanceTab === "non_contractual") {
              const fromDate =
                day >= 27
                  ? `${year}-${String(month).padStart(2, "0")}-27`
                  : getLocalDateKey(new Date(year, month - 2, 27));

              const toDate =
                day >= 27
                  ? getLocalDateKey(new Date(year, month, 26))
                  : `${year}-${String(month).padStart(2, "0")}-26`;

              return (
                <>
                  <b>Advance Cycle:</b> {formatDate(fromDate)} to{" "}
                  {formatDate(toDate)}
                  {"  "}•{"  "}
                  <b>Payable calculated up to:</b>{" "}
                  {formatDate(advanceDate)}
                </>
              );
            }

            return (
              <>
                <b>Advance Cycle:</b> All Employees view selected. Contractual
                and non-contractual employees may follow different cycles.
                {"  "}•{"  "}
                <b>Payable calculated up to:</b>{" "}
                {formatDate(advanceDate)}
                <div
                  style={{
                    marginTop: 6,
                    color: "#b45309",
                    fontSize: 12,
                    fontWeight: 700,
                  }}
                >
                  Contractual advance/payable logic is temporary and will be finalized later.
                </div>
              </>
            );
          })()}
        </div>

        <div
          style={{
            marginTop: 16,
            padding: "10px 12px",
            borderRadius: 8,
            background: "#fff7ed",
            color: "#9a3412",
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          Select the employees who require an advance. Their payable amount
          is calculated from attendance up to the selected date.

          {(() => {
            const dayName = advanceDate
              ? new Date(`${advanceDate}T00:00:00`).toLocaleDateString(
                  "en-US",
                  { weekday: "long" }
                )
              : "";

            const isRegularAdvanceDay =
              dayName === "Tuesday" || dayName === "Saturday";

            if (isRegularAdvanceDay) {
              return (
                <div
                  style={{
                    marginTop: 6,
                    color: "#166534",
                  }}
                >
                  Regular advance day: {dayName}
                </div>
              );
            }

            return (
              <div
                style={{
                  marginTop: 6,
                  color: "#dc2626",
                }}
              >
                Note: {dayName || "Selected date"} is not a regular advance
                day. Use only for emergency advance.
              </div>
            );
          })()}
        </div>
      </>

      <div
        style={{
          marginTop: 16,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: 12,
        }}
      >
        {(() => {
          const totals = advanceEmployeeRows.reduce(
            (summary, row) => {
              const payableSummary = row.payableSummary || {};
              const grossPayable = Number(
                payableSummary.payableAmount || 0
              );
              const previousAdvance = Number(row.previousAdvance || 0);
              const carryForwardBalance = Number(
                row.carryForwardBalance || 0
              );
              const availableBalance = Number(row.availableBalance || 0);

              return {
                grossPayable: summary.grossPayable + grossPayable,
                previousAdvance:
                  summary.previousAdvance + previousAdvance,
                carryForward:
                  summary.carryForward + carryForwardBalance,
                availableBalance:
                  summary.availableBalance + availableBalance,
              };
            },
            {
              grossPayable: 0,
              previousAdvance: 0,
              carryForward: 0,
              availableBalance: 0,
            }
          );


          return (
            <>
              <div className="paper section" style={{ padding: 14 }}>
                <div style={{ fontSize: 12, color: "#666" }}>
                  Total Gross Payable
                </div>

                <div
                  style={{
                    fontSize: 22,
                    fontWeight: 900,
                    color: "#166534",
                  }}
                >
                  ₹
                  {Math.round(
                    totals.grossPayable
                  ).toLocaleString("en-IN")}
                </div>
              </div>

              <div className="paper section" style={{ padding: 14 }}>
                <div style={{ fontSize: 12, color: "#666" }}>
                  Previous Advances
                </div>

                <div
                  style={{
                    fontSize: 22,
                    fontWeight: 900,
                    color: "#dc2626",
                  }}
                >
                  ₹
                  {Math.round(
                    totals.previousAdvance
                  ).toLocaleString("en-IN")}
                </div>
              </div>

              <div className="paper section" style={{ padding: 14 }}>
                <div style={{ fontSize: 12, color: "#666" }}>
                  Previous Carry Forward
                </div>

                <div
                  style={{
                    fontSize: 22,
                    fontWeight: 900,
                    color:
                      totals.carryForward < 0
                        ? "#dc2626"
                        : "#6b7280",
                  }}
                >
                  {totals.carryForward < 0 ? "−" : ""}₹
                  {Math.abs(
                    Math.round(totals.carryForward)
                  ).toLocaleString("en-IN")}
                </div>
              </div>

              <div className="paper section" style={{ padding: 14 }}>
                <div style={{ fontSize: 12, color: "#666" }}>
                  Available Balance
                </div>

                <div
                  style={{
                    fontSize: 22,
                    fontWeight: 900,
                    color:
                      totals.availableBalance < 0
                        ? "#dc2626"
                        : "#b45309",
                  }}
                >
                  {totals.availableBalance < 0 ? "−" : ""}₹
                  {Math.abs(
                    Math.round(totals.availableBalance)
                  ).toLocaleString("en-IN")}
                </div>
              </div>
            </>
          );
        })()}
      </div>

      <div style={{ overflowX: "auto", marginTop: 16 }}>
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            minWidth: 900,
          }}
        >
          <thead>
            <tr style={{ background: "#f3f4f6" }}>
              <th style={{ padding: 10, textAlign: "center", width: 70 }}>
                Select
              </th>

              <th style={{ padding: 10, textAlign: "left" }}>
                Employee
              </th>

              <th style={{ padding: 10, textAlign: "left" }}>
                Type
              </th>

              <th style={{ padding: 10, textAlign: "left" }}>
                Branch
              </th>

              <th style={{ padding: 10, textAlign: "center" }}>
                Payable Period
              </th>

              <th style={{ padding: 10, textAlign: "center" }}>
                Payable Days
              </th>

              <th style={{ padding: 10, textAlign: "right" }}>
  Payable Till Date
</th>

<th style={{ padding: 10, textAlign: "right" }}>
  Starting Balance
</th>

<th style={{ padding: 10, textAlign: "right" }}>
  Previous Advances
</th>

<th style={{ padding: 10, textAlign: "right" }}>
  Previous Carry Forward
</th>

<th style={{ padding: 10, textAlign: "right" }}>
  Available Balance
</th>
            </tr>
          </thead>

          <tbody>
            {advanceEmployeeRows.map(
  ({
    emp,
    payableSummary,
    startingBalance,
    previousAdvance,
    carryForwardBalance,
    availableBalance,
  }) => {
                const isSelected =
                  selectedAdvanceEmployeeIds.includes(emp.id);

                return (
                  <tr
                    key={emp.id}
                    style={{
                      borderTop: "1px solid #e5e7eb",
                      background: isSelected ? "#fff7ed" : "#fff",
                    }}
                  >
                    <td style={{ padding: 10, textAlign: "center" }}>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={(e) => {
                          setSelectedAdvanceEmployeeIds((previous) =>
                            e.target.checked
                              ? [...previous, emp.id]
                              : previous.filter(
                                  (employeeId) => employeeId !== emp.id
                                )
                          );
                        }}
                        style={{
                          width: 18,
                          height: 18,
                          cursor: "pointer",
                        }}
                      />
                    </td>

                    <td style={{ padding: 10, fontWeight: 700 }}>
                      {emp.name}
                    </td>

                    <td style={{ padding: 10 }}>
                      {emp.type === "contractual"
                        ? "Contractual"
                        : "Non-contractual"}
                    </td>

                    <td style={{ padding: 10 }}>
                      {emp.branch || "—"}
                    </td>

                    <td
                      style={{
                        padding: 10,
                        textAlign: "center",
                        fontSize: 12,
                      }}
                    >
                      {payableSummary.fromDate
  ? payableSummary.fromDate.split("-").reverse().join("-")
  : "—"}
<br />
to
<br />
{payableSummary.toDate
  ? payableSummary.toDate.split("-").reverse().join("-")
  : "—"}
                    </td>

                    <td
  style={{
    padding: 10,
    textAlign: "center",
    fontWeight: 700,
  }}
>
  <div>
    {Number(
      payableSummary.payableDays || 0
    ).toFixed(1)}
  </div>

  <div
    style={{
      marginTop: 4,
      fontSize: 11,
      color: "#6b7280",
      fontWeight: 600,
      lineHeight: 1.35,
    }}
  >
    P: {Number(payableSummary.present || 0)} • H:{" "}
{Number(payableSummary.halfday || 0)} • A:{" "}
{Number(payableSummary.absent || 0)} • PH:{" "}
{Number(payableSummary.publicholiday || 0)} • B:{" "}
{Number(payableSummary.bonus || 0)}
  </div>
</td>

                    <td
  style={{
    padding: 10,
    textAlign: "right",
    fontWeight: 800,
    color: "#166534",
  }}
>
  ₹
  {Math.round(
    Number(payableSummary.payableAmount || 0)
  ).toLocaleString("en-IN")}
</td>

<td
  style={{
    padding: 10,
    textAlign: "right",
    fontWeight: 800,
    color:
      Number(startingBalance?.totalOpeningPayable || 0) < 0
        ? "#dc2626"
        : "#1d4ed8",
  }}
>
  <div>
    {Number(startingBalance?.totalOpeningPayable || 0) < 0 ? "−" : ""}₹
    {Math.abs(
      Math.round(Number(startingBalance?.totalOpeningPayable || 0))
    ).toLocaleString("en-IN")}
  </div>

  {startingBalance?.referenceId && (
    <div
      style={{
        marginTop: 4,
        fontSize: 11,
        color: "#6b7280",
        fontWeight: 600,
        lineHeight: 1.35,
      }}
    >
      Salary ₹
      {Math.round(
        Number(startingBalance.openingSalaryPayable || 0)
      ).toLocaleString("en-IN")}{" "}
      • Bonus ₹
      {Math.round(
        Number(startingBalance.openingBonusPayable || 0)
      ).toLocaleString("en-IN")}
      <br />
      Manual Adv ₹
      {Math.round(
        Number(startingBalance.manualAdvancePaid || 0)
      ).toLocaleString("en-IN")}
      {Number(startingBalance.bonusCarryInDays || 0) > 0 && (
        <>
          <br />
          Bonus Carry-in:{" "}
          {Number(startingBalance.bonusCarryInDays || 0)} days
        </>
      )}
    </div>
  )}
</td>


<td
  style={{
    padding: 10,
    textAlign: "right",
    fontWeight: 800,
    color: "#dc2626",
  }}
>
  ₹
  {Math.round(
    Number(previousAdvance || 0)
  ).toLocaleString("en-IN")}
</td>


<td
  style={{
    padding: 10,
    textAlign: "right",
    fontWeight: 800,
    color:
      Number(carryForwardBalance || 0) < 0
        ? "#dc2626"
        : "#6b7280",
  }}
>
  {Number(carryForwardBalance || 0) < 0 ? "−" : ""}₹
  {Math.abs(
    Math.round(Number(carryForwardBalance || 0))
  ).toLocaleString("en-IN")}
</td>

<td
  style={{
    padding: 10,
    textAlign: "right",
    fontWeight: 900,
    color:
      availableBalance < 0
        ? "#dc2626"
        : "#166534",
  }}
>
  {availableBalance < 0 ? "−" : ""}₹
  {Math.abs(
    Math.round(availableBalance)
  ).toLocaleString("en-IN")}
</td>

                  </tr>
                );
              })}

            {advanceEmployeeRows.length === 0 && (
              <tr>
                <td
                  colSpan={10}
                  style={{
                    padding: 30,
                    textAlign: "center",
                    color: "#6b7280",
                  }}
                >
                  {advanceEmployeeSearch.trim()
  ? "No employee matches your search."
  : "No active employees found in this category."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div
  style={{
    marginTop: 16,
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    flexWrap: "wrap",
  }}
>
  <div
    style={{
      display: "flex",
      alignItems: "center",
      gap: 8,
      flexWrap: "wrap",
    }}
  >
    <div
      style={{
        fontWeight: 700,
        color: "#374151",
      }}
    >
      Selected employees: {selectedAdvanceEmployeeIds.length}
    </div>

    <button
      type="button"
      className="btn"
      onClick={() => {
        const visibleEmployeeIds = advanceEmployeeRows.map(
          (row) => row.emp.id
        );

        setSelectedAdvanceEmployeeIds(visibleEmployeeIds);
        setShowAdvanceGenerator(false);
      }}
      style={{
        background: "#2563eb",
        color: "#fff",
        border: "none",
        fontWeight: 700,
      }}
    >
      Select All Visible
    </button>

    <button
      type="button"
      className="btn"
      onClick={() => {
        setSelectedAdvanceEmployeeIds([]);
        setShowAdvanceGenerator(false);
        setAdvanceDraftEntries({});
      }}
      style={{
        background: "#f3f4f6",
        color: "#111827",
        border: "1px solid #d1d5db",
        fontWeight: 700,
      }}
    >
      Clear Selection
    </button>
  </div>

  <button
    type="button"
    className="btn"
    disabled={selectedAdvanceEmployeeIds.length === 0}
    onClick={() => {
      const initialEntries = {};

      payrollEmployees
        .filter((emp) =>
          selectedAdvanceEmployeeIds.includes(emp.id)
        )
        .forEach((emp) => {
                    const payableSummary =
            calculateAdvancePayableTillDate(emp, advanceDate);

          const grossPayable = Number(
            payableSummary.payableAmount || 0
          );

          const previousAdvance =
            getEmployeeAdvanceTotalTillDate(emp, advanceDate);

          const carryForwardBalance =
            getEmployeeCarryForwardBeforeAdvanceDate(emp, advanceDate);

          const startingBalance = getEmployeeStartingPayableBalance(
            emp,
            advanceDate
          );

          const openingPayable = Number(
            startingBalance?.totalOpeningPayable || 0
          );

          const availableBeforeAdvance =
            openingPayable +
            grossPayable +
            Number(carryForwardBalance || 0) -
            Number(previousAdvance || 0);

          initialEntries[emp.id] = {
            grossPayable,
            openingPayable,
            startingBalanceReferenceId:
              startingBalance?.referenceId || "",
            startingBalanceDate:
              startingBalance?.startingBalanceDate || "",
            startingBalanceCoveredTillDate:
              startingBalance?.coveredTillDate || "",
            openingSalaryPayable: Number(
              startingBalance?.openingSalaryPayable || 0
            ),
            openingBonusPayable: Number(
              startingBalance?.openingBonusPayable || 0
            ),
            manualAdvancePaid: Number(
              startingBalance?.manualAdvancePaid || 0
            ),
            payableDays: Number(payableSummary.payableDays || 0),
            present: Number(payableSummary.present || 0),
            halfday: Number(payableSummary.halfday || 0),
            absent: Number(payableSummary.absent || 0),
            publicholiday: Number(payableSummary.publicholiday || 0),
            bonus: Number(payableSummary.bonus || 0),
            previousAdvance: Number(previousAdvance || 0),
            carryForwardBalance: Number(carryForwardBalance || 0),
            payableBeforeAdvance: availableBeforeAdvance,
            advanceAmount: "",
            paymentMode: "",
          };
        });

      setAdvanceDraftEntries(initialEntries);
      setShowAdvanceGenerator(true);
    }}
    style={{
      background:
        selectedAdvanceEmployeeIds.length > 0
          ? "#b45309"
          : "#d1d5db",
      color: "#fff",
      border: "none",
      fontWeight: 800,
      cursor:
        selectedAdvanceEmployeeIds.length > 0
          ? "pointer"
          : "not-allowed",
    }}
  >
    Proceed to Generate Advance →
  </button>
</div>

{showAdvanceGenerator && (
  <div
    className="paper section"
    style={{
      marginTop: 20,
      padding: 20,
      border: "2px solid #fed7aa",
      background: "#fffaf5",
    }}
  >
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "flex-start",
        gap: 12,
        flexWrap: "wrap",
      }}
    >
      <div>
        <h3 style={{ margin: 0 }}>Generate Advance</h3>

        <p style={{ margin: "8px 0 0", color: "#6b7280" }}>
          {selectedAdvanceEmployeeIds.length} selected employee
          {selectedAdvanceEmployeeIds.length === 1 ? "" : "s"} ready
          for advance entry on{" "}
          <b>{advanceDate.split("-").reverse().join("-")}</b>.
        </p>

        {payrollEmployees.some(
          (emp) =>
            selectedAdvanceEmployeeIds
              .map(String)
              .includes(String(emp.id)) &&
            emp.type === "contractual"
        ) && (
          <div
            style={{
              marginTop: 8,
              padding: "8px 10px",
              borderRadius: 8,
              background: "#fffbeb",
              border: "1px solid #fde68a",
              color: "#b45309",
              fontSize: 12,
              fontWeight: 700,
              lineHeight: 1.4,
            }}
          >
            Selected employee(s) include contractual staff. Contractual advance/payable logic is temporary and will be finalized later.
          </div>
        )}
      </div>

      <button
        type="button"
        className="btn"
        onClick={() => {
          setShowAdvanceGenerator(false);
          setAdvanceDraftEntries({});
        }}
      >
        Cancel
      </button>
    </div>

    <div style={{ overflowX: "auto", marginTop: 18 }}>
      <table
        style={{
          width: "100%",
          minWidth: 1050,
          borderCollapse: "collapse",
          background: "#fff",
        }}
      >
        <thead>
          <tr style={{ background: "#ffedd5" }}>
            <th style={{ padding: 10, textAlign: "left" }}>
              Employee
            </th>

            <th style={{ padding: 10, textAlign: "left" }}>
              Type
            </th>

            <th style={{ padding: 10, textAlign: "right" }}>
              Starting Balance
            </th>

            <th style={{ padding: 10, textAlign: "right" }}>
              Gross Payable
            </th>

            <th style={{ padding: 10, textAlign: "right" }}>
              Previous Advances
            </th>

            <th style={{ padding: 10, textAlign: "right" }}>
              Previous Carry Forward
            </th>

            <th style={{ padding: 10, textAlign: "right" }}>
              Available Before Advance
            </th>

            <th style={{ padding: 10, textAlign: "center" }}>
              Advance Amount
            </th>

            <th style={{ padding: 10, textAlign: "center" }}>
              Payment Mode
            </th>

            <th style={{ padding: 10, textAlign: "left" }}>
              Remarks
            </th>

            <th style={{ padding: 10, textAlign: "right" }}>
              Balance After Advance
            </th>
          </tr>
        </thead>

        <tbody>
          {payrollEmployees
            .filter((emp) =>
              selectedAdvanceEmployeeIds.includes(emp.id)
            )
            .map((emp) => {
              const entry = advanceDraftEntries[emp.id] || {};

              const payableBeforeAdvance = Number(
                entry.payableBeforeAdvance || 0
              );

              const advanceAmount = Number(
                entry.advanceAmount || 0
              );

              const balanceAfterAdvance =
                payableBeforeAdvance - advanceAmount;

              return (
                <tr
                  key={emp.id}
                  style={{
                    borderTop: "1px solid #e5e7eb",
                  }}
                >
                  <td style={{ padding: 10, fontWeight: 700 }}>
                    {emp.name}

                    <div
                      style={{
                        marginTop: 3,
                        fontSize: 12,
                        color: "#6b7280",
                        fontWeight: 500,
                      }}
                    >
                      {emp.branch || "—"}
                    </div>
                  </td>

                  <td style={{ padding: 10 }}>
                    {emp.type === "contractual"
                      ? "Contractual"
                      : "Non-contractual"}
                  </td>

                  <td
                    style={{
                      padding: 10,
                      textAlign: "right",
                      fontWeight: 800,
                      color:
                        Number(entry.openingPayable || 0) < 0
                          ? "#dc2626"
                          : "#1d4ed8",
                    }}
                  >
                    <div>
                      {Number(entry.openingPayable || 0) < 0 ? "−" : ""}₹
                      {Math.abs(
                        Math.round(Number(entry.openingPayable || 0))
                      ).toLocaleString("en-IN")}
                    </div>

                    {entry.startingBalanceReferenceId && (
                      <div
                        style={{
                          marginTop: 4,
                          fontSize: 11,
                          color: "#6b7280",
                          fontWeight: 600,
                          lineHeight: 1.35,
                        }}
                      >
                        Salary ₹
                        {Math.round(
                          Number(entry.openingSalaryPayable || 0)
                        ).toLocaleString("en-IN")}{" "}
                        • Bonus ₹
                        {Math.round(
                          Number(entry.openingBonusPayable || 0)
                        ).toLocaleString("en-IN")}
                        <br />
                        Manual Adv ₹
                        {Math.round(
                          Number(entry.manualAdvancePaid || 0)
                        ).toLocaleString("en-IN")}
                      </div>
                    )}
                  </td>

                 <td
  style={{
    padding: 10,
    textAlign: "right",
    fontWeight: 800,
    color: "#166534",
  }}
>
  <div>
    ₹
    {Math.round(
      Number(entry.grossPayable || 0)
    ).toLocaleString("en-IN")}
  </div>

  <div
    style={{
      marginTop: 4,
      fontSize: 11,
      color: "#6b7280",
      fontWeight: 600,
      lineHeight: 1.35,
    }}
  >
    Days: {Number(entry.payableDays || 0).toFixed(1)}
    <br />
    P: {Number(entry.present || 0)} • H:{" "}
{Number(entry.halfday || 0)} • A:{" "}
{Number(entry.absent || 0)} • PH:{" "}
{Number(entry.publicholiday || 0)} • B:{" "}
{Number(entry.bonus || 0)}
  </div>
</td>

<td
  style={{
    padding: 10,
    textAlign: "right",
    fontWeight: 800,
    color: "#dc2626",
  }}
>
  ₹
  {Math.round(
    Number(entry.previousAdvance || 0)
  ).toLocaleString("en-IN")}
</td>

<td
  style={{
    padding: 10,
    textAlign: "right",
    fontWeight: 800,
    color:
      Number(entry.carryForwardBalance || 0) < 0
        ? "#dc2626"
        : "#6b7280",
  }}
>
  {Number(entry.carryForwardBalance || 0) < 0 ? "−" : ""}₹
  {Math.abs(
    Math.round(Number(entry.carryForwardBalance || 0))
  ).toLocaleString("en-IN")}
</td>

<td
  style={{
    padding: 10,
    textAlign: "right",
    fontWeight: 900,
    color:
      payableBeforeAdvance < 0
        ? "#dc2626"
        : "#166534",
  }}
>
  {payableBeforeAdvance < 0 ? "−" : ""}₹
  {Math.abs(
    Math.round(payableBeforeAdvance)
  ).toLocaleString("en-IN")}
</td>

<td style={{ padding: 10, textAlign: "center" }}>
                    <input
  type="number"
  min="0"
  step="1"
  placeholder="Enter amount"
  defaultValue={entry.advanceAmount || ""}
  onBlur={(e) =>
    setAdvanceDraftEntries((previous) => ({
      ...previous,
      [emp.id]: {
        ...(previous[emp.id] || {}),
        advanceAmount: e.target.value,
      },
    }))
  }
  onKeyDown={(e) => {
    if (e.key === "Enter") {
      e.currentTarget.blur();
    }
  }}
  style={{
    width: 130,
    padding: "9px 10px",
    border: "1px solid #d1d5db",
    borderRadius: 8,
    textAlign: "right",
    fontWeight: 700,
  }}
/>
                  </td>

                  <td style={{ padding: 10, textAlign: "center" }}>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "center",
                        gap: 6,
                      }}
                    >
                      <button
                        type="button"
                        className="btn"
                        onClick={() =>
                          setAdvanceDraftEntries((previous) => ({
                            ...previous,
                            [emp.id]: {
                              ...(previous[emp.id] || {}),
                              paymentMode: "cash",
                            },
                          }))
                        }
                        style={{
                          background:
                            entry.paymentMode === "cash"
                              ? "#166534"
                              : "#f3f4f6",
                          color:
                            entry.paymentMode === "cash"
                              ? "#fff"
                              : "#111827",
                          border:
                            entry.paymentMode === "cash"
                              ? "1px solid #166534"
                              : "1px solid #d1d5db",
                          fontWeight: 700,
                        }}
                      >
                        Cash
                      </button>

                      <button
                        type="button"
                        className="btn"
                        onClick={() =>
                          setAdvanceDraftEntries((previous) => ({
                            ...previous,
                            [emp.id]: {
                              ...(previous[emp.id] || {}),
                              paymentMode: "online",
                            },
                          }))
                        }
                        style={{
                          background:
                            entry.paymentMode === "online"
                              ? "#2563eb"
                              : "#f3f4f6",
                          color:
                            entry.paymentMode === "online"
                              ? "#fff"
                              : "#111827",
                          border:
                            entry.paymentMode === "online"
                              ? "1px solid #2563eb"
                              : "1px solid #d1d5db",
                          fontWeight: 700,
                        }}
                      >
                        Online
                      </button>
                    </div>
                  </td>

                  <td style={{ padding: 10 }}>
                    <input
  type="text"
  defaultValue={entry.remarks || ""}
  onBlur={(e) =>
    setAdvanceDraftEntries((previous) => ({
      ...previous,
      [emp.id]: {
        ...(previous[emp.id] || {}),
        remarks: e.target.value,
      },
    }))
  }
  onKeyDown={(e) => {
    if (e.key === "Enter") {
      e.currentTarget.blur();
    }
  }}
  placeholder="Optional"
  style={{
    width: 150,
    padding: "8px 10px",
    border: "1px solid #d1d5db",
    borderRadius: 8,
    fontSize: 13,
  }}
/>
                  </td>

                  <td
  style={{
    padding: 10,
    textAlign: "right",
    fontWeight: 900,
    color:
      balanceAfterAdvance < 0
        ? "#dc2626"
        : "#166534",
  }}
>
  <div>
    {balanceAfterAdvance < 0 ? "−" : ""}₹
    {Math.abs(
      Math.round(balanceAfterAdvance)
    ).toLocaleString("en-IN")}
  </div>

  {balanceAfterAdvance < 0 && (
    <div
      style={{
        marginTop: 4,
        fontSize: 11,
        color: "#dc2626",
        fontWeight: 700,
        lineHeight: 1.3,
      }}
    >
      Excess advance / carry forward
    </div>
  )}
</td>
                </tr>
              );
            })}
        </tbody>
      </table>
    </div>

    <div
  style={{
    marginTop: 18,
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-end",
    gap: 14,
    flexWrap: "wrap",
  }}
>
  <button
    type="button"
    className="btn"
    onClick={() => {
      const selectedEmployees = payrollEmployees.filter((emp) =>
        selectedAdvanceEmployeeIds.includes(emp.id)
      );

      const employeeWithoutAmount = selectedEmployees.find(
        (emp) =>
          Number(
            advanceDraftEntries[emp.id]?.advanceAmount || 0
          ) <= 0
      );

      if (employeeWithoutAmount) {
        alert(
          `Please enter a valid advance amount for ${employeeWithoutAmount.name}.`
        );
        return;
      }

      const employeeWithoutMode = selectedEmployees.find(
        (emp) => !advanceDraftEntries[emp.id]?.paymentMode
      );

      if (employeeWithoutMode) {
        alert(
          `Please select Cash or Online for ${employeeWithoutMode.name}.`
        );
        return;
      }

      const advanceEmployees = selectedEmployees.map((emp) => {
        const payableSummary =
          calculateAdvancePayableTillDate(emp, advanceDate);

        const grossPayable = Number(
  advanceDraftEntries[emp.id]?.grossPayable ||
    payableSummary.payableAmount ||
    0
);

const previousAdvance = Number(
  advanceDraftEntries[emp.id]?.previousAdvance || 0
);

const carryForwardBalance = Number(
  advanceDraftEntries[emp.id]?.carryForwardBalance || 0
);

const openingPayable = Number(
  advanceDraftEntries[emp.id]?.openingPayable || 0
);

const payableBeforeAdvance = Number(
  advanceDraftEntries[emp.id]?.payableBeforeAdvance ||
    openingPayable +
      grossPayable +
      carryForwardBalance -
      previousAdvance
);

const advanceAmount = Number(
  advanceDraftEntries[emp.id]?.advanceAmount || 0
);

return {
  employeeId: emp.id,
  employeeName: emp.name,
  employeeType: emp.type,
  branch: emp.branch || "",
  payableFromDate: payableSummary.fromDate || "",
  payableToDate: advanceDate,

  grossPayable,
  openingPayable,
  startingBalanceReferenceId:
    advanceDraftEntries[emp.id]?.startingBalanceReferenceId || "",
  startingBalanceDate:
    advanceDraftEntries[emp.id]?.startingBalanceDate || "",
  startingBalanceCoveredTillDate:
    advanceDraftEntries[emp.id]?.startingBalanceCoveredTillDate || "",
  openingSalaryPayable: Number(
    advanceDraftEntries[emp.id]?.openingSalaryPayable || 0
  ),
  openingBonusPayable: Number(
    advanceDraftEntries[emp.id]?.openingBonusPayable || 0
  ),
  manualAdvancePaid: Number(
    advanceDraftEntries[emp.id]?.manualAdvancePaid || 0
  ),
payableDays: Number(

  advanceDraftEntries[emp.id]?.payableDays || 0
),
present: Number(
  advanceDraftEntries[emp.id]?.present || 0
),
halfday: Number(
  advanceDraftEntries[emp.id]?.halfday || 0
),
absent: Number(
  advanceDraftEntries[emp.id]?.absent || 0
),
publicholiday: Number(
  advanceDraftEntries[emp.id]?.publicholiday || 0
),
bonus: Number(
  advanceDraftEntries[emp.id]?.bonus || 0
),
previousAdvance,
carryForwardBalance,
payableBeforeAdvance,

advanceAmount,
paymentMode:
  advanceDraftEntries[emp.id]?.paymentMode || "",
remarks:
  advanceDraftEntries[emp.id]?.remarks?.trim() || "",
balanceAfterAdvance:
  payableBeforeAdvance - advanceAmount,
};
      });

      const totalAdvance = advanceEmployees.reduce(
        (sum, entry) => sum + entry.advanceAmount,
        0
      );

      const totalCash = advanceEmployees
        .filter((entry) => entry.paymentMode === "cash")
        .reduce(
          (sum, entry) => sum + entry.advanceAmount,
          0
        );

      const totalOnline = advanceEmployees
        .filter((entry) => entry.paymentMode === "online")
        .reduce(
          (sum, entry) => sum + entry.advanceAmount,
          0
        );

      const contractualAdvanceEmployees = advanceEmployees.filter(
        (entry) => entry.employeeType === "contractual"
      );

      const contractualWarning =
        contractualAdvanceEmployees.length > 0
          ? `\n\nWarning: This advance includes contractual employee(s). Contractual logic is still pending.`
          : "";

      const excessAdvanceEmployees = advanceEmployees.filter(
        (entry) => Number(entry.balanceAfterAdvance || 0) < 0
      );

      const excessWarning =
        excessAdvanceEmployees.length > 0
          ? `\n\nWarning: ${excessAdvanceEmployees.length} employee${
              excessAdvanceEmployees.length === 1 ? "" : "s"
            } will have excess advance / carry-forward.`
          : "";

      const confirmSave = window.confirm(
        `Confirm advance generation?\n\nDate: ${
          advanceDate ? advanceDate.split("-").reverse().join("-") : "—"
        }\nEmployees: ${advanceEmployees.length}\nCash: ₹${Math.round(
          totalCash
        ).toLocaleString("en-IN")}\nOnline: ₹${Math.round(
          totalOnline
        ).toLocaleString("en-IN")}\nGrand Total: ₹${Math.round(
          totalAdvance
        ).toLocaleString("en-IN")}${contractualWarning}${excessWarning}\n\nClick OK to save this advance summary.`
      );

      if (!confirmSave) return;

      const newAdvanceBatch = {
        id: `ADV-${Date.now()}`,
        advanceDate,
        createdAt: new Date().toISOString(),
        employees: advanceEmployees,
        totalAdvance,
        totalCash,
        totalOnline,
      };

      setSavedAdvanceBatches((previous) => [
        newAdvanceBatch,
        ...previous,
      ]);

      setGeneratedAdvanceSummary(newAdvanceBatch);
      setShowAdvanceGenerator(false);
      setSelectedAdvanceEmployeeIds([]);
      setAdvanceDraftEntries({});

      alert("Advance summary generated and saved ✅");
    }}
    style={{
      background: "#b45309",
      color: "#fff",
      border: "none",
      fontWeight: 800,
      padding: "11px 18px",
    }}
  >
    Generate & Save Advance
  </button>

   <div
    style={{
      display: "grid",
      gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
      gap: 10,
      minWidth: 520,
      flex: 1,
    }}
  >
    {(() => {
      const cashTotal = selectedAdvanceEmployeeIds.reduce(
        (total, employeeId) =>
          advanceDraftEntries[employeeId]?.paymentMode === "cash"
            ? total +
              Number(
                advanceDraftEntries[employeeId]?.advanceAmount || 0
              )
            : total,
        0
      );

      const onlineTotal = selectedAdvanceEmployeeIds.reduce(
        (total, employeeId) =>
          advanceDraftEntries[employeeId]?.paymentMode === "online"
            ? total +
              Number(
                advanceDraftEntries[employeeId]?.advanceAmount || 0
              )
            : total,
        0
      );

      const grandTotal = cashTotal + onlineTotal;

      return (
        <>
          <div
            style={{
              padding: 14,
              borderRadius: 10,
              background: "#f0fdf4",
              border: "1px solid #bbf7d0",
              textAlign: "right",
            }}
          >
            <div style={{ fontSize: 12, color: "#166534" }}>
              Cash Total
            </div>

            <div
              style={{
                marginTop: 4,
                fontSize: 22,
                fontWeight: 900,
                color: "#166534",
              }}
            >
              ₹{Math.round(cashTotal).toLocaleString("en-IN")}
            </div>
          </div>

          <div
            style={{
              padding: 14,
              borderRadius: 10,
              background: "#eff6ff",
              border: "1px solid #bfdbfe",
              textAlign: "right",
            }}
          >
            <div style={{ fontSize: 12, color: "#2563eb" }}>
              Online Total
            </div>

            <div
              style={{
                marginTop: 4,
                fontSize: 22,
                fontWeight: 900,
                color: "#2563eb",
              }}
            >
              ₹{Math.round(onlineTotal).toLocaleString("en-IN")}
            </div>
          </div>

          <div
            style={{
              padding: 14,
              borderRadius: 10,
              background: "#fff7ed",
              border: "1px solid #fed7aa",
              textAlign: "right",
            }}
          >
            <div style={{ fontSize: 12, color: "#9a3412" }}>
              Grand Total Advance
            </div>

            <div
              style={{
                marginTop: 4,
                fontSize: 22,
                fontWeight: 900,
                color: "#b45309",
              }}
            >
              ₹{Math.round(grandTotal).toLocaleString("en-IN")}
            </div>
          </div>
        </>
      );
    })()}
  </div>
    </div>
  </div>
)}

{generatedAdvanceSummary && (
  <div
    className="paper section"
    style={{
      marginTop: 20,
      padding: 20,
      border: "2px solid #bbf7d0",
      background: "#f0fdf4",
    }}
  >
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "flex-start",
        gap: 12,
        flexWrap: "wrap",
      }}
    >
      <div>
        <h3 style={{ margin: 0 }}>Generated Advance Summary</h3>

        {generatedAdvanceSummary.employees?.some(
          (entry) => entry.employeeType === "contractual"
        ) && (
          <div
            style={{
              marginTop: 8,
              padding: "8px 10px",
              borderRadius: 8,
              background: "#fffbeb",
              border: "1px solid #fde68a",
              color: "#b45309",
              fontSize: 12,
              fontWeight: 700,
              lineHeight: 1.4,
            }}
          >
            This summary includes contractual employee(s). Contractual advance/payable logic is temporary and will be finalized later.
          </div>
        )}

        <div
  style={{
    marginTop: 6,
    color: "#4b5563",
    fontSize: 13,
    lineHeight: 1.5,
  }}
>
  <div>
    Advance Date:{" "}
    <b>
      {generatedAdvanceSummary.advanceDate
        ?.split("-")
        .reverse()
        .join("-")}
    </b>
  </div>

  <div>
    Reference ID:{" "}
    <b>{generatedAdvanceSummary.id || "—"}</b>
  </div>

  {generatedAdvanceSummary.createdAt && (
    <div>
      Saved At:{" "}
      <b>
        {(() => {
          const savedDate = new Date(generatedAdvanceSummary.createdAt);

          const day = String(savedDate.getDate()).padStart(2, "0");
          const month = String(savedDate.getMonth() + 1).padStart(2, "0");
          const year = savedDate.getFullYear();

          const hours = String(savedDate.getHours()).padStart(2, "0");
          const minutes = String(savedDate.getMinutes()).padStart(2, "0");

          return `${day}-${month}-${year} ${hours}:${minutes}`;
        })()}
      </b>
    </div>
  )}
</div>
      </div>

      <div
  style={{
    display: "flex",
    gap: 8,
    flexWrap: "wrap",
  }}
>
  <button
    type="button"
    className="btn"
    onClick={() =>
      downloadAdvanceSummaryPdf(generatedAdvanceSummary)
    }
    style={{
      background: "#166534",
      color: "#fff",
      border: "none",
      fontWeight: 700,
    }}
  >
    Download PDF
  </button>

  <button
    type="button"
    className="btn"
    onClick={() =>
      downloadAdvanceVoucherPdf(generatedAdvanceSummary)
    }
    style={{
      background: "#7c3aed",
      color: "#fff",
      border: "none",
      fontWeight: 700,
    }}
  >
    Voucher PDF
  </button>

  <button
    type="button"
    className="btn"
    onClick={() => {
      const confirmed = window.confirm(
        `Delete this advance summary dated ${
          generatedAdvanceSummary.advanceDate
            ? generatedAdvanceSummary.advanceDate
                .split("-")
                .reverse()
                .join("-")
            : ""
        }?\n\nThis action cannot be undone.`
      );

      if (!confirmed) return;

      setSavedAdvanceBatches((previous) =>
        previous.filter(
          (batch) => batch.id !== generatedAdvanceSummary.id
        )
      );

      setGeneratedAdvanceSummary(null);
    }}
    style={{
      background: "#dc2626",
      color: "#fff",
      border: "none",
      fontWeight: 700,
    }}
  >
    Delete Summary
  </button>

  <button
    type="button"
    className="btn"
    onClick={() => setGeneratedAdvanceSummary(null)}
  >
    Close Summary
  </button>
</div>
    </div>

   <div style={{ overflowX: "visible", marginTop: 18 }}>
  <table
    style={{
      width: "100%",
      minWidth: "100%",
      borderCollapse: "collapse",
      background: "#fff",
      tableLayout: "fixed",
      fontSize: 12,
    }}
  >
        <thead>
          <tr style={{ background: "#dcfce7" }}>
            <th style={{ padding: 10, textAlign: "left" }}>
              Employee
            </th>

            <th style={{ padding: 10, textAlign: "left" }}>
              Type
            </th>

            <th style={{ padding: 10, textAlign: "left" }}>
              Branch
            </th>

            <th style={{ padding: 10, textAlign: "center" }}>
              Payable Period
            </th>

            <th style={{ padding: 10, textAlign: "right" }}>
  Gross Payable
</th>

<th style={{ padding: 10, textAlign: "right" }}>
  Previous Advances
</th>

<th style={{ padding: 10, textAlign: "right" }}>
  Previous Carry Forward
</th>

<th style={{ padding: 10, textAlign: "right" }}>
  Available Before Advance
</th>

<th style={{ padding: 10, textAlign: "right" }}>
  Current Advance
</th>

<th style={{ padding: 10, textAlign: "center" }}>
  Mode
</th>

<th style={{ padding: 10, textAlign: "right" }}>
  Balance After Advance
</th>
          </tr>
        </thead>

        <tbody>
          {generatedAdvanceSummary.employees.map((entry) => (
            <tr
              key={entry.employeeId}
              style={{ borderTop: "1px solid #e5e7eb" }}
            >
              <td style={{ padding: 10, fontWeight: 700 }}>
  {entry.employeeName}

  {entry.remarks && (
    <div
      style={{
        marginTop: 4,
        fontSize: 11,
        color: "#92400e",
        fontWeight: 600,
        lineHeight: 1.3,
      }}
    >
      Remarks: {entry.remarks}
    </div>
  )}
</td>

              <td style={{ padding: 10 }}>
                {entry.employeeType === "contractual"
                  ? "Contractual"
                  : "Non-contractual"}
              </td>

              <td style={{ padding: 10 }}>
                {entry.branch || "—"}
              </td>

              <td
                style={{
                  padding: 10,
                  textAlign: "center",
                  fontSize: 12,
                }}
              >
                {entry.payableFromDate
                  ? entry.payableFromDate
                      .split("-")
                      .reverse()
                      .join("-")
                  : "—"}
                <br />
                to
                <br />
                {entry.payableToDate
                  ? entry.payableToDate
                      .split("-")
                      .reverse()
                      .join("-")
                  : "—"}
              </td>

              <td
  style={{
    padding: 10,
    textAlign: "right",
    fontWeight: 700,
    color: "#166534",
  }}
>
  <div>
    ₹
    {Math.round(
      Number(
        entry.grossPayable ??
          Number(entry.payableBeforeAdvance || 0) +
            Number(entry.previousAdvance || 0)
      )
    ).toLocaleString("en-IN")}
  </div>

  <div
    style={{
      marginTop: 4,
      fontSize: 11,
      color: "#6b7280",
      fontWeight: 600,
      lineHeight: 1.35,
    }}
  >
    Days: {Number(entry.payableDays || 0).toFixed(1)}
    <br />
    P: {Number(entry.present || 0)} • H:{" "}
{Number(entry.halfday || 0)} • A:{" "}
{getAdvanceEntryAbsentCount(
  entry,
  generatedAdvanceSummary.advanceDate
)} • PH:{" "}
{Number(entry.publicholiday || 0)} • B:{" "}
{Number(entry.bonus || 0)}
  </div>
</td>

<td
  style={{
    padding: 10,
    textAlign: "right",
    fontWeight: 800,
    color: "#dc2626",
  }}
>
  ₹
  {Math.round(
    Number(entry.previousAdvance || 0)
  ).toLocaleString("en-IN")}
</td>

<td
  style={{
    padding: 10,
    textAlign: "right",
    fontWeight: 800,
    color:
      Number(entry.carryForwardBalance || 0) < 0
        ? "#dc2626"
        : "#6b7280",
  }}
>
  {Number(entry.carryForwardBalance || 0) < 0 ? "−" : ""}₹
  {Math.abs(
    Math.round(Number(entry.carryForwardBalance || 0))
  ).toLocaleString("en-IN")}
</td>

<td
  style={{
    padding: 10,
    textAlign: "right",
    fontWeight: 900,
    color:
      Number(entry.payableBeforeAdvance || 0) < 0
        ? "#dc2626"
        : "#166534",
  }}
>
  <div>
    {Number(entry.payableBeforeAdvance || 0) < 0 ? "−" : ""}₹
    {Math.abs(
      Math.round(Number(entry.payableBeforeAdvance || 0))
    ).toLocaleString("en-IN")}
  </div>

  {Number(entry.openingPayable || 0) !== 0 && (
    <div
      style={{
        marginTop: 4,
        fontSize: 11,
        color: "#1d4ed8",
        fontWeight: 700,
        lineHeight: 1.35,
      }}
    >
      Includes Starting ₹
      {Math.round(
        Number(entry.openingPayable || 0)
      ).toLocaleString("en-IN")}
      {entry.startingBalanceReferenceId && (
        <>
          <br />
          Ref: {entry.startingBalanceReferenceId}
        </>
      )}
    </div>
  )}
</td>

<td
  style={{
    padding: 10,
    textAlign: "right",
    fontWeight: 800,
    color: "#b45309",
  }}
>
  ₹
  {Math.round(
    Number(entry.advanceAmount || 0)
  ).toLocaleString("en-IN")}
</td>

              <td
                style={{
                  padding: 10,
                  textAlign: "center",
                  fontWeight: 700,
                }}
              >
                {entry.paymentMode === "cash"
                  ? "Cash"
                  : "Online"}
              </td>

              <td
  style={{
    padding: 10,
    textAlign: "right",
    fontWeight: 900,
    color:
      Number(entry.balanceAfterAdvance || 0) < 0
        ? "#dc2626"
        : "#166534",
  }}
>
  <div>
    {Number(entry.balanceAfterAdvance || 0) < 0
      ? "−"
      : ""}
    ₹
    {Math.abs(
      Math.round(
        Number(entry.balanceAfterAdvance || 0)
      )
    ).toLocaleString("en-IN")}
  </div>

  {Number(entry.balanceAfterAdvance || 0) < 0 && (
    <div
      style={{
        marginTop: 4,
        fontSize: 11,
        color: "#dc2626",
        fontWeight: 700,
        lineHeight: 1.3,
      }}
    >
      Excess advance / carry forward
    </div>
  )}
</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>

    <div
      style={{
        marginTop: 18,
        display: "grid",
        gridTemplateColumns:
          "repeat(auto-fit, minmax(180px, 1fr))",
        gap: 12,
      }}
    >
      <div
        style={{
          padding: 14,
          borderRadius: 10,
          background: "#fff",
          border: "1px solid #d1fae5",
        }}
      >
        <div style={{ fontSize: 12, color: "#6b7280" }}>
          Cash Total
        </div>

        <div
          style={{
            marginTop: 4,
            fontSize: 22,
            fontWeight: 900,
            color: "#166534",
          }}
        >
          ₹
          {Math.round(
            Number(generatedAdvanceSummary.totalCash || 0)
          ).toLocaleString("en-IN")}
        </div>
      </div>

      <div
        style={{
          padding: 14,
          borderRadius: 10,
          background: "#fff",
          border: "1px solid #dbeafe",
        }}
      >
        <div style={{ fontSize: 12, color: "#6b7280" }}>
          Online Total
        </div>

        <div
          style={{
            marginTop: 4,
            fontSize: 22,
            fontWeight: 900,
            color: "#2563eb",
          }}
        >
          ₹
          {Math.round(
            Number(generatedAdvanceSummary.totalOnline || 0)
          ).toLocaleString("en-IN")}
        </div>
      </div>

      <div
        style={{
          padding: 14,
          borderRadius: 10,
          background: "#166534",
          color: "#fff",
        }}
      >
        <div style={{ fontSize: 12, opacity: 0.85 }}>
          Grand Total Advance
        </div>

        <div
          style={{
            marginTop: 4,
            fontSize: 24,
            fontWeight: 900,
          }}
        >
          ₹
          {Math.round(
            Number(generatedAdvanceSummary.totalAdvance || 0)
          ).toLocaleString("en-IN")}
        </div>
      </div>
    </div>
  </div>
)}

<div
  className="paper section"
  style={{
    marginTop: 20,
    padding: 20,
  }}
>
  <div
    style={{
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      gap: 12,
      flexWrap: "wrap",
    }}
  >
    <div>
      <h3 style={{ margin: 0 }}>Saved Advance History</h3>

      <p
        style={{
          margin: "6px 0 0",
          color: "#6b7280",
          fontSize: 13,
        }}
      >
        Generated advance summaries are permanently saved here.
      </p>
    </div>

    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        flexWrap: "wrap",
      }}
    >
      <input
  type="text"
  value={advanceHistorySearch}
  onChange={(e) => setAdvanceHistorySearch(e.target.value)}
  placeholder="Search history"
  style={{
    padding: "8px 10px",
    border: "1px solid #d1d5db",
    borderRadius: 8,
    fontSize: 13,
    minWidth: 190,
  }}
/>

{advanceHistorySearch.trim() && (
  <button
    type="button"
    className="btn"
    onClick={() => setAdvanceHistorySearch("")}
    style={{
      background: "#f3f4f6",
      color: "#111827",
      border: "1px solid #d1d5db",
      fontWeight: 700,
      padding: "8px 10px",
    }}
  >
    Clear
  </button>
)}

<div
  style={{
          padding: "8px 12px",
          borderRadius: 20,
          background: "#fff7ed",
          color: "#9a3412",
          fontWeight: 800,
        }}
      >
        {getFilteredAdvanceBatches().length} shown / {savedAdvanceBatches.length} saved
      </div>
    </div>
  </div>

  {savedAdvanceBatches.length > 0 ? (
    <>
      <div
        style={{
          marginTop: 16,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
          gap: 12,
        }}
      >
        {(() => {
          const historyTotals = getFilteredAdvanceBatches().reduce(
            (summary, batch) => ({
              totalCash:
                summary.totalCash + Number(batch.totalCash || 0),
              totalOnline:
                summary.totalOnline + Number(batch.totalOnline || 0),
              totalAdvance:
                summary.totalAdvance + Number(batch.totalAdvance || 0),
            }),
            {
              totalCash: 0,
              totalOnline: 0,
              totalAdvance: 0,
            }
          );

          return (
            <>
              <div
                style={{
                  padding: 14,
                  borderRadius: 10,
                  background: "#f9fafb",
                  border: "1px solid #e5e7eb",
                }}
              >
                <div style={{ fontSize: 12, color: "#6b7280" }}>
                  Saved Batches
                </div>

                <div
                  style={{
                    marginTop: 4,
                    fontSize: 22,
                    fontWeight: 900,
                    color: "#111827",
                  }}
                >
                  {savedAdvanceBatches.length}
                </div>
              </div>

              <div
                style={{
                  padding: 14,
                  borderRadius: 10,
                  background: "#f0fdf4",
                  border: "1px solid #bbf7d0",
                }}
              >
                <div style={{ fontSize: 12, color: "#166534" }}>
                  Total Cash
                </div>

                <div
                  style={{
                    marginTop: 4,
                    fontSize: 22,
                    fontWeight: 900,
                    color: "#166534",
                  }}
                >
                  ₹
                  {Math.round(
                    historyTotals.totalCash
                  ).toLocaleString("en-IN")}
                </div>
              </div>

              <div
                style={{
                  padding: 14,
                  borderRadius: 10,
                  background: "#eff6ff",
                  border: "1px solid #bfdbfe",
                }}
              >
                <div style={{ fontSize: 12, color: "#2563eb" }}>
                  Total Online
                </div>

                <div
                  style={{
                    marginTop: 4,
                    fontSize: 22,
                    fontWeight: 900,
                    color: "#2563eb",
                  }}
                >
                  ₹
                  {Math.round(
                    historyTotals.totalOnline
                  ).toLocaleString("en-IN")}
                </div>
              </div>

              <div
                style={{
                  padding: 14,
                  borderRadius: 10,
                  background: "#fff7ed",
                  border: "1px solid #fed7aa",
                }}
              >
                <div style={{ fontSize: 12, color: "#9a3412" }}>
                  Total Advance
                </div>

                <div
                  style={{
                    marginTop: 4,
                    fontSize: 22,
                    fontWeight: 900,
                    color: "#b45309",
                  }}
                >
                  ₹
                  {Math.round(
                    historyTotals.totalAdvance
                  ).toLocaleString("en-IN")}
                </div>
              </div>
            </>
          );
        })()}
      </div>

      <div style={{ overflowX: "auto", marginTop: 16 }}>
        <table
        style={{
          width: "100%",
          minWidth: 900,
          borderCollapse: "collapse",
        }}
      >
        <thead>
          <tr style={{ background: "#f3f4f6" }}>
            <th style={{ padding: 10, textAlign: "center" }}>
              Date
            </th>

            <th style={{ padding: 10, textAlign: "left" }}>
  Employees
</th>

            <th style={{ padding: 10, textAlign: "right" }}>
              Cash
            </th>

            <th style={{ padding: 10, textAlign: "right" }}>
              Online
            </th>

            <th style={{ padding: 10, textAlign: "right" }}>
              Total Advance
            </th>

            <th style={{ padding: 10, textAlign: "center" }}>
              Actions
            </th>
          </tr>
        </thead>

        <tbody>
          {getFilteredAdvanceBatches().map((batch) => (
            <tr
              key={batch.id}
              style={{ borderTop: "1px solid #e5e7eb" }}
            >
              <td
  style={{
    padding: 10,
    textAlign: "center",
    fontWeight: 700,
  }}
>
  <div>
    {batch.advanceDate
      ? batch.advanceDate
          .split("-")
          .reverse()
          .join("-")
      : "—"}
  </div>

  <div
    style={{
      marginTop: 4,
      fontSize: 11,
      color: "#6b7280",
      fontWeight: 600,
    }}
  >
    {batch.id || "—"}
  </div>

  {batch.createdAt && (
    <div
      style={{
        marginTop: 3,
        fontSize: 11,
        color: "#9ca3af",
        fontWeight: 600,
      }}
    >
      {(() => {
        const savedDate = new Date(batch.createdAt);

        const day = String(savedDate.getDate()).padStart(2, "0");
        const month = String(savedDate.getMonth() + 1).padStart(2, "0");
        const year = savedDate.getFullYear();

        const hours = String(savedDate.getHours()).padStart(2, "0");
        const minutes = String(savedDate.getMinutes()).padStart(2, "0");

        return `${day}-${month}-${year} ${hours}:${minutes}`;
      })()}
    </div>
  )}
</td>

              <td
  style={{
    padding: 10,
    textAlign: "left",
  }}
>
  <div style={{ fontWeight: 800 }}>
    {batch.employees?.length || 0} employee
    {(batch.employees?.length || 0) === 1 ? "" : "s"}
  </div>

  <div
  style={{
    marginTop: 4,
    fontSize: 12,
    color: "#6b7280",
    lineHeight: 1.35,
  }}
>
  {(batch.employees || [])
    .map((entry) => entry.employeeName)
    .filter(Boolean)
    .join(", ")}
</div>

{(batch.employees || []).some(
  (entry) => entry.employeeType === "contractual"
) && (
  <div
    style={{
      marginTop: 4,
      fontSize: 11,
      color: "#b45309",
      lineHeight: 1.35,
      fontWeight: 700,
    }}
  >
    Includes contractual employee(s) — logic pending
  </div>
)}

{(batch.employees || []).some((entry) => entry.remarks) && (
  <div
    style={{
      marginTop: 4,
      fontSize: 11,
      color: "#92400e",
      lineHeight: 1.35,
      fontWeight: 600,
    }}
  >
    Remarks:{" "}
    {(batch.employees || [])
      .filter((entry) => entry.remarks)
      .map((entry) => `${entry.employeeName}: ${entry.remarks}`)
      .join(" • ")}
  </div>
)}
</td>

              <td
                style={{
                  padding: 10,
                  textAlign: "right",
                  color: "#166534",
                  fontWeight: 700,
                }}
              >
                ₹
                {Math.round(
                  Number(batch.totalCash || 0)
                ).toLocaleString("en-IN")}
              </td>

              <td
                style={{
                  padding: 10,
                  textAlign: "right",
                  color: "#2563eb",
                  fontWeight: 700,
                }}
              >
                ₹
                {Math.round(
                  Number(batch.totalOnline || 0)
                ).toLocaleString("en-IN")}
              </td>

              <td
                style={{
                  padding: 10,
                  textAlign: "right",
                  color: "#b45309",
                  fontWeight: 900,
                }}
              >
                ₹
                {Math.round(
                  Number(batch.totalAdvance || 0)
                ).toLocaleString("en-IN")}
              </td>

              <td style={{ padding: 10, textAlign: "center" }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "center",
                    gap: 8,
                    flexWrap: "wrap",
                  }}
                >
                 <button
  type="button"
  className="btn"
  onClick={() =>
    setGeneratedAdvanceSummary(batch)
  }
  style={{
    background: "#2563eb",
    color: "#fff",
    border: "none",
    fontWeight: 700,
  }}
>
  View Summary
</button>

<button
  type="button"
  className="btn"
  onClick={() => downloadAdvanceSummaryPdf(batch)}
  style={{
    background: "#166534",
    color: "#fff",
    border: "none",
    fontWeight: 700,
  }}
>
  PDF
</button>

<button
  type="button"
  className="btn"
  onClick={() => downloadAdvanceVoucherPdf(batch)}
  style={{
    background: "#7c3aed",
    color: "#fff",
    border: "none",
    fontWeight: 700,
  }}
>
  Voucher
</button>

<button
  type="button"
  className="btn"
  onClick={() => {
                      const confirmed = window.confirm(
                        `Delete the advance summary dated ${
                          batch.advanceDate
                            ? batch.advanceDate
                                .split("-")
                                .reverse()
                                .join("-")
                            : ""
                        }?\n\nThis action cannot be undone.`
                      );

                      if (!confirmed) return;

                      setSavedAdvanceBatches((previous) =>
                        previous.filter(
                          (savedBatch) =>
                            savedBatch.id !== batch.id
                        )
                      );

                      if (
                        generatedAdvanceSummary?.id === batch.id
                      ) {
                        setGeneratedAdvanceSummary(null);
                      }
                    }}
                    style={{
                      background: "#dc2626",
                      color: "#fff",
                      border: "none",
                      fontWeight: 700,
                    }}
                  >
                    Delete
                  </button>
                </div>
              </td>
            </tr>
                    ))}

          {getFilteredAdvanceBatches().length === 0 && (
            <tr>
              <td
                colSpan={6}
                style={{
                  padding: 24,
                  textAlign: "center",
                  color: "#6b7280",
                  fontWeight: 700,
                }}
              >
                No matching advance history found.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
    </>
  ) : (
    <div
      style={{
        marginTop: 16,
        padding: 24,
        borderRadius: 10,
        background: "#f9fafb",
        textAlign: "center",
        color: "#6b7280",
      }}
    >
      No advance summaries have been saved yet.
    </div>
  )}
</div>

<div
  className="paper section"
  style={{
    marginTop: 20,
    padding: 20,
  }}
>
  <div
    style={{
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      gap: 12,
      flexWrap: "wrap",
    }}
  >
    <div>
      <h3 style={{ margin: 0 }}>
        Saved Salary Payment History
      </h3>

      <p
        style={{
          margin: "6px 0 0",
          color: "#6b7280",
          fontSize: 13,
        }}
      >
        Imported historical salary payments are saved here.
      </p>
    </div>

    <div
      style={{
        padding: "8px 12px",
        borderRadius: 20,
        background: "#ecfdf5",
        color: "#166534",
        fontWeight: 800,
      }}
    >
      {savedHistoricalSalaryPaymentBatches.length} saved
    </div>
  </div>

  {savedHistoricalSalaryPaymentBatches.length > 0 ? (
    <>
      <div
        style={{
          marginTop: 16,
          display: "grid",
          gridTemplateColumns:
            "repeat(auto-fit, minmax(160px, 1fr))",
          gap: 12,
        }}
      >
        {(() => {
          const salaryHistoryTotals =
            savedHistoricalSalaryPaymentBatches.reduce(
              (summary, batch) => {
                (batch.payments || []).forEach((payment) => {
                  const amount = Number(payment.amount || 0);

                  summary.totalAmount += amount;
                  summary.paymentCount += 1;

                  if (payment.paymentMode === "Online") {
                    summary.totalOnline += amount;
                  } else {
                    summary.totalCash += amount;
                  }
                });

                return summary;
              },
              {
                totalCash: 0,
                totalOnline: 0,
                totalAmount: 0,
                paymentCount: 0,
              }
            );

          return (
            <>
              <div
                style={{
                  padding: 14,
                  borderRadius: 10,
                  background: "#f9fafb",
                  border: "1px solid #e5e7eb",
                }}
              >
                <div
                  style={{
                    fontSize: 12,
                    color: "#6b7280",
                  }}
                >
                  Salary Payments
                </div>

                <div
                  style={{
                    marginTop: 4,
                    fontSize: 22,
                    fontWeight: 900,
                  }}
                >
                  {salaryHistoryTotals.paymentCount}
                </div>
              </div>

              <div
                style={{
                  padding: 14,
                  borderRadius: 10,
                  background: "#f0fdf4",
                  border: "1px solid #bbf7d0",
                }}
              >
                <div
                  style={{
                    fontSize: 12,
                    color: "#166534",
                  }}
                >
                  Total Cash
                </div>

                <div
                  style={{
                    marginTop: 4,
                    fontSize: 22,
                    fontWeight: 900,
                    color: "#166534",
                  }}
                >
                  ₹
                  {Math.round(
                    salaryHistoryTotals.totalCash
                  ).toLocaleString("en-IN")}
                </div>
              </div>

              <div
                style={{
                  padding: 14,
                  borderRadius: 10,
                  background: "#eff6ff",
                  border: "1px solid #bfdbfe",
                }}
              >
                <div
                  style={{
                    fontSize: 12,
                    color: "#2563eb",
                  }}
                >
                  Total Online
                </div>

                <div
                  style={{
                    marginTop: 4,
                    fontSize: 22,
                    fontWeight: 900,
                    color: "#2563eb",
                  }}
                >
                  ₹
                  {Math.round(
                    salaryHistoryTotals.totalOnline
                  ).toLocaleString("en-IN")}
                </div>
              </div>

              <div
                style={{
                  padding: 14,
                  borderRadius: 10,
                  background: "#ecfdf5",
                  border: "1px solid #a7f3d0",
                }}
              >
                <div
                  style={{
                    fontSize: 12,
                    color: "#047857",
                  }}
                >
                  Total Salary Paid
                </div>

                <div
                  style={{
                    marginTop: 4,
                    fontSize: 22,
                    fontWeight: 900,
                    color: "#047857",
                  }}
                >
                  ₹
                  {Math.round(
                    salaryHistoryTotals.totalAmount
                  ).toLocaleString("en-IN")}
                </div>
              </div>
            </>
          );
        })()}
      </div>

      <div
        style={{
          overflowX: "auto",
          marginTop: 16,
        }}
      >
        <table
          style={{
            width: "100%",
            minWidth: 1050,
            borderCollapse: "collapse",
          }}
        >
          <thead>
            <tr style={{ background: "#f3f4f6" }}>
              <th
                style={{
                  padding: 10,
                  textAlign: "center",
                }}
              >
                Payment Date
              </th>

              <th
                style={{
                  padding: 10,
                  textAlign: "left",
                }}
              >
                Employee
              </th>

              <th
                style={{
                  padding: 10,
                  textAlign: "center",
                }}
              >
                Salary Period
              </th>

              <th
                style={{
                  padding: 10,
                  textAlign: "center",
                }}
              >
                Mode
              </th>

              <th
                style={{
                  padding: 10,
                  textAlign: "right",
                }}
              >
                Amount
              </th>

              <th
                style={{
                  padding: 10,
                  textAlign: "left",
                }}
              >
                Remarks
              </th>

              <th
                style={{
                  padding: 10,
                  textAlign: "center",
                }}
              >
                Actions
              </th>
            </tr>
          </thead>

         <tbody>
  {[...savedHistoricalSalaryPaymentBatches]
    .sort((a, b) => {
      const aPayment =
        a.paymentDate ||
        a.payments?.[0]?.paymentDate ||
        "";

      const bPayment =
        b.paymentDate ||
        b.payments?.[0]?.paymentDate ||
        "";

      return String(bPayment).localeCompare(
        String(aPayment)
      );
    })
    .map((batch) => {
      const payments = batch.payments || [];

      if (!payments.length) {
        return null;
      }

      const firstPayment = payments[0];

      const paymentDate =
        batch.paymentDate ||
        firstPayment.paymentDate ||
        "";

      const salaryPeriodFrom =
        firstPayment.salaryPeriodFrom || "";

      const salaryPeriodTo =
        firstPayment.salaryPeriodTo || "";

      const employeeType =
        batch.employeeType ||
        firstPayment.employeeType ||
        "";

      const employeeTypeLabel =
        employeeType === "contractual"
          ? "Contractual"
          : "Non-contractual";

      const totalCash = payments
        .filter(
          (payment) =>
            payment.paymentMode !== "Online"
        )
        .reduce(
          (total, payment) =>
            total +
            Number(payment.amount || 0),
          0
        );

      const totalOnline = payments
        .filter(
          (payment) =>
            payment.paymentMode === "Online"
        )
        .reduce(
          (total, payment) =>
            total +
            Number(payment.amount || 0),
          0
        );

      const totalPaid =
        totalCash + totalOnline;

      const formatSalaryHistoryDate = (
        dateValue
      ) =>
        dateValue
          ? String(dateValue)
              .split("-")
              .reverse()
              .join("-")
          : "—";

      const employeeNames = payments
        .map(
          (payment) =>
            payment.employeeName || ""
        )
        .filter(Boolean);

      return (
        <tr
          key={batch.id}
          style={{
            borderTop:
              "1px solid #d1d5db",
            background: "#f9fafb",
          }}
        >
          <td
            style={{
              padding: 12,
              textAlign: "center",
              fontWeight: 800,
              verticalAlign: "top",
            }}
          >
            {formatSalaryHistoryDate(
              paymentDate
            )}
          </td>

          <td
            style={{
              padding: 12,
              textAlign: "left",
              verticalAlign: "top",
            }}
          >
            <div
              style={{
                fontWeight: 900,
                color:
                  employeeType ===
                  "contractual"
                    ? "#1d4ed8"
                    : "#9a3412",
              }}
            >
              {employeeTypeLabel}
            </div>

            <div
              style={{
                marginTop: 4,
                fontSize: 12,
                color: "#6b7280",
              }}
            >
              {payments.length} payment
              {payments.length === 1
                ? ""
                : "s"}
            </div>

            <div
              title={employeeNames.join(", ")}
              style={{
                marginTop: 5,
                maxWidth: 240,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                fontSize: 11,
                color: "#6b7280",
              }}
            >
              {employeeNames
                .slice(0, 3)
                .join(", ")}
              {employeeNames.length > 3
                ? ` +${
                    employeeNames.length - 3
                  } more`
                : ""}
            </div>
          </td>

          <td
            style={{
              padding: 12,
              textAlign: "center",
              fontWeight: 700,
              verticalAlign: "top",
            }}
          >
            {formatSalaryHistoryDate(
              salaryPeriodFrom
            )}
            {" to "}
            {formatSalaryHistoryDate(
              salaryPeriodTo
            )}
          </td>

          <td
            style={{
              padding: 12,
              textAlign: "center",
              verticalAlign: "top",
            }}
          >
            <div
              style={{
                fontWeight: 800,
                color: "#166534",
              }}
            >
              Cash
            </div>

            <div
              style={{
                marginTop: 3,
                fontSize: 12,
                fontWeight: 800,
                color: "#166534",
              }}
            >
              ₹
              {Math.round(
                totalCash
              ).toLocaleString("en-IN")}
            </div>

            {totalOnline > 0 && (
              <>
                <div
                  style={{
                    marginTop: 7,
                    fontWeight: 800,
                    color: "#2563eb",
                  }}
                >
                  Online
                </div>

                <div
                  style={{
                    marginTop: 3,
                    fontSize: 12,
                    fontWeight: 800,
                    color: "#2563eb",
                  }}
                >
                  ₹
                  {Math.round(
                    totalOnline
                  ).toLocaleString(
                    "en-IN"
                  )}
                </div>
              </>
            )}
          </td>

          <td
            style={{
              padding: 12,
              textAlign: "right",
              fontWeight: 900,
              fontSize: 16,
              color: "#047857",
              verticalAlign: "top",
            }}
          >
            ₹
            {Math.round(
              totalPaid
            ).toLocaleString("en-IN")}
          </td>

          <td
            style={{
              padding: 12,
              textAlign: "left",
              fontSize: 12,
              color: "#6b7280",
              verticalAlign: "top",
            }}
          >
            Historical salary payment
            import
          </td>

          <td
            style={{
              padding: 12,
              textAlign: "center",
              verticalAlign: "top",
            }}
          >
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "stretch",
                gap: 7,
                minWidth: 125,
              }}
            >
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setSelectedHistoricalSalaryPaymentBatch(
                    batch
                  );
                  setShowHistoricalSalaryPaymentSummaryDialog(
                    true
                  );
                }}
                style={{
                  background: "#2563eb",
                  color: "#ffffff",
                  border: "none",
                  fontWeight: 800,
                }}
              >
                View Summary
              </button>

              <button
  type="button"
  className="btn"
  onClick={() => {
    setSelectedExpandedHistoricalSalaryPaymentBatch(
      batch
    );
    setShowHistoricalSalaryPaymentExpandDialog(
      true
    );
  }}
  style={{
    background: "#ffffff",
    color: "#111827",
    border: "1px solid #9ca3af",
    fontWeight: 800,
    width: "100%",
  }}
>
  Expand
</button>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  const confirmed =
                    window.confirm(
                      `Delete this entire ${employeeTypeLabel} salary-payment import?\n\nPayment Date: ${formatSalaryHistoryDate(
                        paymentDate
                      )}\nSalary Period: ${formatSalaryHistoryDate(
                        salaryPeriodFrom
                      )} to ${formatSalaryHistoryDate(
                        salaryPeriodTo
                      )}\nPayments: ${
                        payments.length
                      }\nTotal: ₹${Math.round(
                        totalPaid
                      ).toLocaleString(
                        "en-IN"
                      )}\n\nThis action cannot be undone.`
                    );

                  if (!confirmed) {
                    return;
                  }

                  setSavedHistoricalSalaryPaymentBatches(
                    (previous) =>
                      previous.filter(
                        (savedBatch) =>
                          savedBatch.id !==
                          batch.id
                      )
                  );
                }}
                style={{
                  background: "#dc2626",
                  color: "#ffffff",
                  border: "none",
                  fontWeight: 700,
                }}
              >
                Delete Import
              </button>
            </div>
          </td>
        </tr>
      );
    })}
</tbody>
        </table>
      </div>
    </>
  ) : (
    <div
      style={{
        marginTop: 16,
        padding: 24,
        borderRadius: 10,
        background: "#f9fafb",
        textAlign: "center",
        color: "#6b7280",
      }}
    >
      No historical salary payments have been saved yet.
    </div>
  )}
</div>

    </div>

  </div>
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

{isAdmin && (
  <button
    onClick={() => {
      setEditingProductId(m.id);
      setEditingImageUrl(m.image_url || "");
      setEditForm({
  name: m.name || "",
  category: m.category || "",
  mrp: m.mrp || "",
  sell_price: m.sell_price || "",
  cost_price: m.cost_price || "",
  specs: m.specs || "",
  imageFile: null,
});
      window.scrollTo({ top: 0, behavior: "smooth" });
    }}
    style={{
      marginTop: "6px",
      marginBottom: "6px",
      padding: "6px 10px",
      fontSize: "12px",
      background: "#222",
      color: "#fff",
      border: "none",
      borderRadius: "6px",
      cursor: "pointer",
      alignSelf: "center",
    }}
  >
    Edit
  </button>
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
          width: savedView === "sanctioned" ? "95%" : "100%",
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
  hidden={isSanctioned || Boolean(q?.delivered_date || deliveredDateStr)}
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
{(deliveredDateStr || q?.delivered_date) && (
  <span
    className="badge"
    style={{
      alignSelf: "center",
      background: "#eaf7ea",   // subtle green background
      color: "#155724"         // readable green text
    }}
    title={`Delivered • ${deliveredDateStr || (q?.delivered_date ? fmtDate(q.delivered_date) : "")}`}
  >
    Delivered • {deliveredDateStr || (q?.delivered_date ? fmtDate(q.delivered_date) : "")}
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

<button
  className="btn primary"
  onClick={() => setPage("attendance")}
  style={{ marginBottom: 8 }}
>
  📋 Record Attendance
</button>




  {(isAdmin || quoteMode) && (
    <button
      type="button"
      onClick={openPayrollPage}
      className="btn"
      style={{
        background: "#1f7a3f",
        color: "#fff",
        border: "none",
        fontWeight: 700,
        marginBottom: 8,
      }}
    >
      💼 Payroll
    </button>
  )}

  {(isAdmin || quoteMode) && (
    <button
      type="button"
      onClick={() => setPage("advance")}
      className="btn"
      style={{
        background: "#b45309",
        color: "#fff",
        border: "none",
        fontWeight: 700,
        marginBottom: 8,
      }}
    >
      💰 Advance Payment
    </button>
  )}

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