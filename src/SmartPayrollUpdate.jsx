import React, { useRef, useState } from "react";
import * as XLSX from "xlsx";

const dateKey = (date) => {
  const d = new Date(date);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
};

const datesBetween = (from, to) => {
  if (!from || !to || from > to) return [];
  const dates = [];
  const cursor = new Date(`${from}T12:00:00`);
  const end = new Date(`${to}T12:00:00`);
  while (cursor <= end) {
    dates.push(dateKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
};

const normalizeDate = (value) => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return dateKey(value);
  if (typeof value === "number") {
    const parts = XLSX.SSF.parse_date_code(value);
    return parts ? `${parts.y}-${String(parts.m).padStart(2, "0")}-${String(parts.d).padStart(2, "0")}` : "";
  }
  const text = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const match = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (!match) return "";
  const year = match[3].length === 2 ? `20${match[3]}` : match[3];
  return `${year}-${String(match[2]).padStart(2, "0")}-${String(match[1]).padStart(2, "0")}`;
};

const rowValue = (row, ...keys) => {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null) return row[key];
  }
  return "";
};

const amountValue = (value) => {
  if (value === "" || value == null) return NaN;
  return Number(String(value).replace(/[₹,\s]/g, ""));
};

export default function SmartPayrollUpdate({
  employees = [],
  attendanceEntries = {},
  savedAdvanceBatches = [],
  advanceNoPaymentConfirmations = [],
  savedSalaryBatches = [],
  salaryDrafts = [],
  onSave,
  onAdjustDraft,
  onDeleteDraft,
  onBack,
}) {
  const today = dateKey(new Date());
  const [periodStart, setPeriodStart] = useState(() => {
    const current = new Date(`${today}T12:00:00`);
    const cycleEnd = new Date(current.getFullYear(), current.getMonth() - (current.getDate() <= 26 ? 1 : 0), 26);
    return dateKey(new Date(cycleEnd.getFullYear(), cycleEnd.getMonth() - 1, 27));
  });
  const [periodEnd, setPeriodEnd] = useState(() => {
    const current = new Date(`${today}T12:00:00`);
    return dateKey(new Date(current.getFullYear(), current.getMonth() - (current.getDate() <= 26 ? 1 : 0), 26));
  });
  const [asOfDate, setAsOfDate] = useState(today);
  const [employeeScope, setEmployeeScope] = useState("non_contractual");
  const [preview, setPreview] = useState(null);
  const [selectedSheets, setSelectedSheets] = useState({
    Attendance: true,
    Advances: true,
    "Emergency Advances": false,
    "Salary Cycle": false,
    "Previous Salary": false,
  });
  const [working, setWorking] = useState(false);
  const [pendingDraftEdits, setPendingDraftEdits] = useState({});
  const inputRef = useRef(null);

  const setPendingDraftEdit = (draftId, employeeId, changes) => {
    const key = `${draftId}|${employeeId}`;
    setPendingDraftEdits((current) => ({ ...current, [key]: { ...(current[key] || {}), ...changes } }));
  };
  const clearDraftEdits = (draftId) => {
    setPendingDraftEdits((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(`${draftId}|`))));
  };
  const saveDraftEdits = (draft) => {
    Object.entries(pendingDraftEdits).forEach(([key, changes]) => {
      if (key.startsWith(`${draft.id}|`)) onAdjustDraft?.(draft.id, key.slice(draft.id.length + 1), changes);
    });
    clearDraftEdits(draft.id);
  };
  const removeDraft = (draft) => {
    if (!window.confirm("Remove this unpaid salary draft? Attendance and advance records imported from the workbook will remain saved.")) return;
    onDeleteDraft?.(draft.id);
    clearDraftEdits(draft.id);
  };

  const activeEmployees = employees.filter((employee) =>
    (employeeScope === "all" || employee.type === employeeScope)
      && (employee.status || "active") === "active"
  );
  const employeeScopeLabel = employeeScope === "all"
    ? "all active employees"
    : employeeScope === "contractual" ? "active contractual employees" : "active non-contractual employees";

  // Database IDs created by the Add Employee form can be timestamps. Keep those
  // internal keys untouched, but give them compact consecutive workbook IDs.
  const numericEmployeeIds = employees
    .map((employee) => String(employee.id ?? ""))
    .filter((id) => /^\d{1,6}$/.test(id))
    .map(Number);
  let nextWorkbookEmployeeId = Math.max(0, ...numericEmployeeIds) + 1;
  const workbookEmployeeIds = new Map();
  activeEmployees.forEach((employee) => {
    const id = String(employee.id ?? "");
    if (/^\d{1,6}$/.test(id)) workbookEmployeeIds.set(id, Number(id));
  });
  activeEmployees
    .filter((employee) => !/^\d{1,6}$/.test(String(employee.id ?? "")))
    .slice()
    .sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }))
    .forEach((employee) => {
      workbookEmployeeIds.set(String(employee.id), nextWorkbookEmployeeId);
      nextWorkbookEmployeeId += 1;
    });
  const workbookEmployeeId = (employee) => workbookEmployeeIds.get(String(employee.id)) ?? employee.id;

  const downloadTemplate = async () => {
    if (periodStart > periodEnd || periodEnd > asOfDate) {
      alert("Check the dates: the salary cycle must end on or before the as-of date.");
      return;
    }
    const attendanceDateCandidates = datesBetween(periodStart, asOfDate);
    const attendanceDates = attendanceDateCandidates.filter((date) => activeEmployees.some((employee) => {
      if (employee.joining_date && date < employee.joining_date) return false;
      return !attendanceEntries[`${date}_${employee.id}`];
    }));
    const attendanceEmployees = activeEmployees.filter((employee) => attendanceDates.some((date) =>
      !employee.joining_date || date >= employee.joining_date
    ));
    const displayDate = (date) => {
      const [year, month, day] = date.split("-");
      return `${day}/${month}/${year}`;
    };
    const attendanceHeaders = ["Employee_ID", "Employee_Name", "Branch", ...attendanceDates.map(displayDate)];
    const attendanceRows = attendanceEmployees.map((employee) => {
      const row = {
        Employee_ID: workbookEmployeeId(employee),
        Employee_Name: employee.name,
        Branch: employee.branch || "",
      };
      attendanceDates.forEach((date) => {
        const dateHeader = displayDate(date);
        if (employee.joining_date && date < employee.joining_date) {
          row[dateHeader] = "—";
          return;
        }
        const key = `${date}_${employee.id}`;
        if (attendanceEntries[key]) {
          row[dateHeader] = "#";
          return;
        }
        const dayName = new Date(`${date}T12:00:00`).toLocaleDateString("en-US", { weekday: "long" }).toLowerCase();
        const knownWeeklyOff = employee.weekly_off && employee.weekly_off !== "none" && employee.weekly_off === dayName;
        row[dateHeader] = knownWeeklyOff ? "W" : "";
      });
      return row;
    });

    const savedAdvanceEmployeesByDate = new Set();
    savedAdvanceBatches.forEach((batch) => (batch.employees || []).forEach((entry) => {
      savedAdvanceEmployeesByDate.add(`${batch.advanceDate}|${entry.employeeId}`);
    }));
    const confirmedNoAdvanceEmployeesByDate = new Set(advanceNoPaymentConfirmations.map((entry) => `${entry.date}|${entry.employeeId}`));
    const advanceDates = datesBetween(periodStart, asOfDate).filter((date) => {
      const day = new Date(`${date}T12:00:00`).getDay();
      return day === 2 || day === 6;
    });
    const advanceRows = activeEmployees.map((employee) => {
      const row = {
      Employee_ID: workbookEmployeeId(employee),
      Employee_Name: employee.name,
      Branch: employee.branch || "",
      };
      advanceDates.forEach((date) => {
        const key = `${date}|${employee.id}`;
        row[displayDate(date)] = savedAdvanceEmployeesByDate.has(key)
          ? "#"
          : confirmedNoAdvanceEmployeesByDate.has(key) ? 0 : "";
      });
      return row;
    });
    const emergencyAdvanceRows = Array.from({ length: 12 }, () => ({
      Paid: "",
      Date: "",
      Employee_ID: "",
      Employee_Name: "",
      Amount: "",
      Payment_Mode: "Cash",
      Emergency: "Yes",
      Notes: "",
    }));

    const salaryRows = activeEmployees.map((employee) => ({
      Employee_ID: workbookEmployeeId(employee),
      Employee_Name: employee.name,
      Salary_Period_From: periodStart,
      Salary_Period_To: periodEnd,
      Planned_Payment_Date: dateKey(new Date(new Date(`${periodEnd}T12:00:00`).getFullYear(), new Date(`${periodEnd}T12:00:00`).getMonth() + 1, 3)),
      Base_Monthly_Salary: Number(employee.base_salary || 0),
      Register_Adjustment: "",
      Adjustment_Reason: "",
    }));
    const previousSalaryRows = activeEmployees.map((employee) => ({
      Employee_ID: workbookEmployeeId(employee),
      Employee_Name: employee.name,
      Salary_Period_From: "",
      Salary_Period_To: "",
      Payment_Date: "",
      Salary_Paid_Amount: "",
      Payment_Mode: "Cash",
      Remarks: "",
    }));

    const workbook = XLSX.utils.book_new();
    const wrapInstruction = (text, lineLength = 74) => {
      const words = text.split(/\s+/);
      const lines = [];
      let line = "";
      words.forEach((word) => {
        if (line && `${line} ${word}`.length > lineLength) {
          lines.push(line);
          line = word;
        } else {
          line = line ? `${line} ${word}` : word;
        }
      });
      if (line) lines.push(line);
      return lines.join("\n");
    };
    const readme = [
      { Topic: "Scope", Instructions: wrapInstruction(`${employeeScopeLabel[0].toUpperCase()}${employeeScopeLabel.slice(1)}. Salary period ${displayDate(periodStart)} to ${displayDate(periodEnd)}; attendance and actual advances through ${displayDate(asOfDate)}. Dates use DD/MM/YYYY.`) },
      { Topic: "Attendance", Instructions: wrapInstruction("One employee per row; dates with at least one gap are columns. Enter P (Present), A (Absent), H (Half day), W (Weekly off), PH (Public holiday), or NJ (Not Joined) in blank cells. Use NJ only when you have confirmed the employee had not joined on that date. # means a mark is already saved for that employee/date; leave it unchanged. — means the app knows the date was before joining; do not fill. Known weekly offs are prefilled W. Leave uncertain dates blank and resolve them before upload.") },
      { Topic: "Advances", Instructions: wrapInstruction("One employee per row; scheduled Tuesdays and Saturdays are columns. # means a paid advance is already saved; leave it unchanged. Enter a positive amount only when an advance was actually paid. Enter 0 to confirm that you checked and no advance was taken; this confirmation is saved separately and does not count as a payment. Leave blank if the date is still unknown or unchecked; it will remain a gap next time. Use Emergency Advances for actual off-schedule payments, mark Paid=Yes, and add a note.") },
      { Topic: "Salary Cycle", Instructions: wrapInstruction("One employee per row. Salary period and planned payment dates use DD/MM/YYYY. Use Register_Adjustment only to reconcile against your register; enter a positive or negative amount and explain it. This is an unpaid draft, not a payment record.") },
      { Topic: "Previous Salary", Instructions: wrapInstruction("Use only for a salary payment already paid earlier but missing from the app. Fill Salary_Period_From and Salary_Period_To with the dates the pay covers, Payment_Date with the actual day it was paid, Salary_Paid_Amount with the paid amount, and Payment_Mode. Use DD/MM/YYYY. Leave the row blank if no earlier paid cycle is missing; do not enter the current unpaid cycle.") },
      { Topic: "Upload", Instructions: wrapInstruction("Keep the sheet names and column headings unchanged. The app previews duplicates and errors before saving.") },
    ];
    const makeReadableSheet = (rows, headers, widthBounds) => {
      const worksheet = XLSX.utils.json_to_sheet(rows, headers ? { header: headers } : undefined);
      const columnCount = headers?.length || Object.keys(rows[0] || {}).length;
      const valuesByColumn = Array.from({ length: columnCount }, (_, columnIndex) => {
        const key = headers?.[columnIndex] || Object.keys(rows[0] || {})[columnIndex];
        return [key, ...rows.map((row) => String(row[key] ?? ""))];
      });
      worksheet["!cols"] = valuesByColumn.map((values, index) => {
        const [minWidth, maxWidth] = widthBounds[index] || [12, 36];
        const longest = values.reduce((length, value) => Math.max(length, value.length), 0);
        return { wch: Math.min(maxWidth, Math.max(minWidth, longest + 2)) };
      });

      // Give wrapped instructions and notes enough vertical room after Excel/Numbers opens the file.
      const range = XLSX.utils.decode_range(worksheet["!ref"] || "A1:A1");
      worksheet["!rows"] = Array.from({ length: range.e.r + 1 }, (_, rowIndex) => {
        if (rowIndex === 0) return { hpt: 26 };
        let visualLines = 1;
        for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
          const cell = worksheet[XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex })];
          const value = String(cell?.v ?? "");
          const width = worksheet["!cols"][columnIndex]?.wch || 16;
          const lines = value.split("\n").reduce((total, line) => total + Math.max(1, Math.ceil(line.length / Math.max(8, width - 2))), 0);
          visualLines = Math.max(visualLines, lines);
        }
        return { hpt: Math.min(84, Math.max(22, visualLines * 16)) };
      });
      return worksheet;
    };

    XLSX.utils.book_append_sheet(workbook, makeReadableSheet(readme, ["Topic", "Instructions"], [[16, 24], [68, 88]]), "Read Me");
    XLSX.utils.book_append_sheet(workbook, makeReadableSheet(attendanceRows, attendanceHeaders, [[13, 16], [22, 32], [20, 30], ...attendanceDates.map(() => [14, 16])]), "Attendance");
    const advanceHeaders = ["Employee_ID", "Employee_Name", "Branch", ...advanceDates.map(displayDate)];
    XLSX.utils.book_append_sheet(workbook, makeReadableSheet(advanceRows, advanceHeaders, [[13, 16], [22, 32], [20, 30], ...advanceDates.map(() => [14, 16])]), "Advances");
    const emergencyAdvanceHeaders = ["Paid", "Date", "Employee_ID", "Employee_Name", "Amount", "Payment_Mode", "Emergency", "Notes"];
    XLSX.utils.book_append_sheet(workbook, makeReadableSheet(emergencyAdvanceRows, emergencyAdvanceHeaders, [[12, 14], [14, 16], [13, 16], [22, 32], [14, 18], [16, 22], [14, 16], [24, 52]]), "Emergency Advances");
    XLSX.utils.book_append_sheet(workbook, makeReadableSheet(salaryRows, Object.keys(salaryRows[0] || {}), [[13, 16], [22, 32], [20, 22], [20, 22], [22, 26], [20, 24], [20, 24], [28, 56]]), "Salary Cycle");
    XLSX.utils.book_append_sheet(workbook, makeReadableSheet(previousSalaryRows, Object.keys(previousSalaryRows[0] || {}), [[13, 16], [22, 32], [20, 22], [20, 22], [18, 22], [20, 24], [16, 22], [24, 52]]), "Previous Salary");
    const excelJsModule = await import("exceljs");
    const ExcelJS = excelJsModule.default || excelJsModule;
    const styledWorkbook = new ExcelJS.Workbook();
    await styledWorkbook.xlsx.load(XLSX.write(workbook, { bookType: "xlsx", type: "array" }));
    const gridBorder = {
      top: { style: "thin", color: { argb: "FFD9E0E8" } },
      right: { style: "thin", color: { argb: "FFD9E0E8" } },
      bottom: { style: "thin", color: { argb: "FFD9E0E8" } },
      left: { style: "thin", color: { argb: "FFD9E0E8" } },
    };
    const applyGridStyle = (sheet, firstInputColumn, shouldHighlight, lastStyleRow = sheet?.rowCount || 1) => {
      if (!sheet) return;
      for (let rowIndex = 1; rowIndex <= lastStyleRow; rowIndex += 1) {
        for (let columnIndex = 1; columnIndex <= sheet.columnCount; columnIndex += 1) {
          const cell = sheet.getCell(rowIndex, columnIndex);
          cell.border = rowIndex === 1
            ? { ...gridBorder, bottom: { style: "medium", color: { argb: "FFB8C4D2" } } }
            : gridBorder;
          if (rowIndex > 1 && columnIndex >= firstInputColumn && shouldHighlight(rowIndex, columnIndex, cell)) {
            cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFBEA" } };
          }
        }
      }
    };
    // Explicit borders keep filled cells looking like a table in Numbers and Excel.
    const attendanceSheet = styledWorkbook.getWorksheet("Attendance");
    applyGridStyle(attendanceSheet, 4, (_rowIndex, _columnIndex, cell) => cell.value === null || cell.value === undefined || cell.value === "");
    const advancesSheet = styledWorkbook.getWorksheet("Advances");
    applyGridStyle(advancesSheet, 4, (_rowIndex, _columnIndex, cell) => cell.value === null || cell.value === undefined || cell.value === "");
    const emergencySheet = styledWorkbook.getWorksheet("Emergency Advances");
    applyGridStyle(emergencySheet, 1, (_rowIndex, columnIndex, cell) => [1, 2, 3, 4, 5].includes(columnIndex) && (cell.value === null || cell.value === undefined || cell.value === ""), emergencySheet?.rowCount || 1);
    const salaryCycleSheet = styledWorkbook.getWorksheet("Salary Cycle");
    applyGridStyle(salaryCycleSheet, 7, (_rowIndex, columnIndex, cell) => [7, 8].includes(columnIndex) && (cell.value === null || cell.value === undefined || cell.value === ""));
    const previousSalarySheet = styledWorkbook.getWorksheet("Previous Salary");
    applyGridStyle(previousSalarySheet, 3, (_rowIndex, columnIndex, cell) => [3, 4, 5, 6].includes(columnIndex) && (cell.value === null || cell.value === undefined || cell.value === ""));
    const dateColumnsBySheet = {
      "Emergency Advances": ["Date"],
      "Salary Cycle": ["Salary_Period_From", "Salary_Period_To", "Planned_Payment_Date"],
      "Previous Salary": ["Salary_Period_From", "Salary_Period_To", "Payment_Date"],
    };
    Object.entries(dateColumnsBySheet).forEach(([sheetName, dateHeaders]) => {
      const sheet = styledWorkbook.getWorksheet(sheetName);
      if (!sheet) return;
      const columnIndexes = dateHeaders.map((header) => {
        const column = sheet.getRow(1).values.findIndex((value) => value === header);
        return column > 0 ? column : -1;
      }).filter((column) => column > 0);
      for (const columnIndex of columnIndexes) {
        for (let rowIndex = 2; rowIndex <= Math.max(sheet.rowCount, 12); rowIndex += 1) {
          const cell = sheet.getCell(rowIndex, columnIndex);
          if (typeof cell.value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(cell.value)) {
            cell.value = new Date(`${cell.value}T12:00:00`);
          }
          cell.numFmt = "dd/mm/yyyy";
        }
      }
    });
    const fileBuffer = await styledWorkbook.xlsx.writeBuffer();
    const fileBlob = new Blob([fileBuffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const downloadUrl = URL.createObjectURL(fileBlob);
    const downloadLink = document.createElement("a");
    downloadLink.href = downloadUrl;
    downloadLink.download = `HVF_Smart_Payroll_Update_${asOfDate}.xlsx`;
    document.body.appendChild(downloadLink);
    downloadLink.click();
    downloadLink.remove();
    URL.revokeObjectURL(downloadUrl);
  };

  const handleFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setWorking(true);
    try {
      const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
      const sheetRows = (name) => workbook.Sheets[name]
        ? XLSX.utils.sheet_to_json(workbook.Sheets[name], { defval: "" }) : [];
      if (!["Attendance", "Advances", "Salary Cycle", "Previous Salary"].every((name) => workbook.Sheets[name])) {
        throw new Error("This workbook must include Attendance, Advances, Salary Cycle, and Previous Salary tabs.");
      }
      const byId = new Map(activeEmployees.map((employee) => [String(employee.id), employee]));
      const byWorkbookId = new Map(activeEmployees.map((employee) => [String(workbookEmployeeId(employee)), employee]));
      const byName = new Map(activeEmployees.map((employee) => [String(employee.name || "").trim().toLowerCase(), employee]));
      const findEmployee = (row) => {
        const id = String(rowValue(row, "Employee_ID", "Employee ID", "ID"));
        const name = String(rowValue(row, "Employee_Name", "Employee Name", "Name")).trim().toLowerCase();
        return byWorkbookId.get(id) || byName.get(name) || byId.get(id);
      };
      const errors = [];
      const attendance = [];
      const seenAttendance = new Set();
      sheetRows("Attendance").forEach((row, index) => {
        const employee = findEmployee(row);
        const legacyDate = normalizeDate(rowValue(row, "Date", "Attendance_Date"));
        const dateCells = legacyDate
          ? [[legacyDate, rowValue(row, "Status", "Attendance")]]
          : Object.entries(row)
            .map(([header, value]) => [normalizeDate(header), value])
            .filter(([date]) => Boolean(date));
        const statusMap = { P: "present", PRESENT: "present", A: "absent", ABSENT: "absent", H: "halfday", HALF: "halfday", HALFDAY: "halfday", W: "weekoff", WEEKOFF: "weekoff", PH: "publicholiday", PUBLICHOLIDAY: "publicholiday", NJ: "notjoined", "NOT JOINED": "notjoined" };
        for (const [date, rawValue] of dateCells) {
          const rawStatus = String(rawValue || "").trim().toUpperCase();
          if (!rawStatus || rawStatus === "#" || rawStatus === "—" || rawStatus === "-") continue;
          if (!employee) { errors.push(`Attendance row ${index + 2}: employee is not in the selected ${employeeScopeLabel} group.`); continue; }
          const status = statusMap[rawStatus];
          if (!date || date < periodStart || date > asOfDate) { errors.push(`Attendance row ${index + 2}: date must be between ${periodStart} and ${asOfDate}.`); continue; }
          if (!status) { errors.push(`Attendance row ${index + 2}, ${date}: use P, A, H, W, PH, or NJ; # and — are informational markers.`); continue; }
          if (status === "notjoined") {
            const key = `${date}_${employee.id}`;
            if (!attendanceEntries[key]) attendance.push({ key, value: status, employeeId: employee.id, employeeName: employee.name, date });
            continue;
          }
          if (employee.joining_date && date < employee.joining_date) { errors.push(`Attendance row ${index + 2}: ${employee.name} had not joined on ${date}.`); continue; }
          const key = `${date}_${employee.id}`;
          if (seenAttendance.has(key)) { errors.push(`Attendance row ${index + 2}: duplicate employee/date in this file.`); continue; }
          seenAttendance.add(key);
          if (attendanceEntries[key]) {
            if (attendanceEntries[key] === status) continue;
            errors.push(`Attendance row ${index + 2}: ${employee.name} already has a different saved mark on ${date}.`);
            continue;
          }
          attendance.push({ key, value: status, employeeId: employee.id, employeeName: employee.name, date });
        }
      });

      const advances = [];
      const noAdvanceConfirmations = [];
      const seenAdvances = new Set();
      const seenNoAdvanceConfirmations = new Set();
      const existingAdvanceEmployeesByDate = new Map();
      savedAdvanceBatches.forEach((batch) => (batch.employees || []).forEach((entry) => {
        existingAdvanceEmployeesByDate.set(`${batch.advanceDate}|${entry.employeeId}`, Number(entry.advanceAmount || 0));
      }));
      const savedNoAdvanceKeys = new Set(advanceNoPaymentConfirmations.map((entry) => `${entry.date}|${entry.employeeId}`));
      const importAdvance = (row, index, { emergency = false, matrixDate = "" } = {}) => {
        const paid = String(rowValue(row, "Paid", "Paid?", "Actually_Paid") || "").trim().toLowerCase();
        const amountRaw = matrixDate ? row[matrixDate] : rowValue(row, "Amount", "Advance_Amount");
        const rowLabel = emergency ? "Emergency Advances" : "Advances";
        const marker = String(amountRaw ?? "").trim();
        if (!marker || marker === "#" || marker === "—" || marker === "-") return;
        const isNoAdvanceConfirmation = matrixDate && ["0", "N/A", "NA", "NO ADVANCE"].includes(marker.toUpperCase());
        if (!matrixDate && paid !== "yes") { errors.push(`${rowLabel} row ${index + 2}: mark Paid as Yes for an actual payment; unconfirmed entries are not imported.`); return; }
        const employee = findEmployee(row);
        const date = matrixDate ? normalizeDate(matrixDate) : normalizeDate(rowValue(row, "Date", "Advance_Date"));
        const amount = amountValue(amountRaw);
        if (!employee) { errors.push(`${rowLabel} row ${index + 2}: employee is not in the selected ${employeeScopeLabel} group.`); return; }
        if (!date || date > asOfDate) { errors.push(`${rowLabel} row ${index + 2}: enter an actual payment date on or before ${asOfDate}.`); return; }
        if (isNoAdvanceConfirmation) {
          const key = `${date}|${employee.id}`;
          if (seenAdvances.has(key)) { errors.push(`Advances row ${index + 2}: ${employee.name} has a paid amount for ${date} elsewhere in this workbook; it cannot also be marked 0.`); return; }
          if (existingAdvanceEmployeesByDate.has(key)) { errors.push(`Advances row ${index + 2}: ${employee.name} already has a paid advance on ${date}; a zero confirmation would conflict.`); return; }
          if (savedNoAdvanceKeys.has(key)) return;
          if (seenNoAdvanceConfirmations.has(key)) { errors.push(`Advances row ${index + 2}: duplicate employee/date confirmation in this file.`); return; }
          seenNoAdvanceConfirmations.add(key);
          noAdvanceConfirmations.push({ employeeId: employee.id, employeeName: employee.name, date });
          return;
        }
        if (!Number.isFinite(amount) || amount <= 0) { errors.push(`${rowLabel} row ${index + 2}: enter a positive amount only when payment was actually made.`); return; }
        const key = `${date}|${employee.id}`;
        if (seenAdvances.has(key) || seenNoAdvanceConfirmations.has(key)) { errors.push(`${rowLabel} row ${index + 2}: duplicate employee/date in this workbook.`); return; }
        seenAdvances.add(key);
        if (savedNoAdvanceKeys.has(key)) { errors.push(`${rowLabel} row ${index + 2}: ${employee.name} already has a no-advance confirmation on ${date}; resolve the conflict before importing.`); return; }
        if (existingAdvanceEmployeesByDate.has(key)) {
          if (existingAdvanceEmployeesByDate.get(key) === amount) return;
          errors.push(`${rowLabel} row ${index + 2}: ${employee.name} already has a different saved advance amount on ${date}; resolve the conflict before importing.`);
          return;
        }
        advances.push({ employeeId: employee.id, employeeName: employee.name, employeeType: employee.type, branch: employee.branch || "", advanceDate: date, amount, paymentMode: String(rowValue(row, "Payment_Mode", "Payment Mode") || "Cash"), emergency: emergency ? "Yes" : String(rowValue(row, "Emergency") || "No"), remarks: String(rowValue(row, "Notes", "Remarks") || "") });
      };
      sheetRows("Advances").forEach((row, index) => {
        const legacyDate = normalizeDate(rowValue(row, "Date", "Advance_Date"));
        if (legacyDate) {
          importAdvance(row, index);
          return;
        }
        Object.keys(row).filter((header) => normalizeDate(header)).forEach((dateHeader) => {
          importAdvance(row, index, { matrixDate: dateHeader });
        });
      });
      sheetRows("Emergency Advances").forEach((row, index) => importAdvance(row, index, { emergency: true }));

      const salaryAdjustments = [];
      const seenSalaryAdjustments = new Set();
      sheetRows("Salary Cycle").forEach((row, index) => {
        const rowPeriodFrom = normalizeDate(rowValue(row, "Salary_Period_From", "Salary Period From"));
        const rowPeriodTo = normalizeDate(rowValue(row, "Salary_Period_To", "Salary Period To"));
        if ((rowPeriodFrom && rowPeriodFrom !== periodStart) || (rowPeriodTo && rowPeriodTo !== periodEnd)) {
          errors.push(`Salary Cycle row ${index + 2}: the period must match ${periodStart} through ${periodEnd}.`);
          return;
        }
        const adjustmentRaw = rowValue(row, "Register_Adjustment", "Register Adjustment");
        const reason = String(rowValue(row, "Adjustment_Reason", "Adjustment Reason") || "").trim();
        if (adjustmentRaw === "" && !reason) return;
        const employee = findEmployee(row);
        const adjustment = amountValue(adjustmentRaw || 0);
        if (!employee || !Number.isFinite(adjustment)) { errors.push(`Salary Cycle row ${index + 2}: employee and a valid numeric adjustment are required.`); return; }
        if (employee.type === "contractual") { errors.push(`Salary Cycle row ${index + 2}: contractual salary adjustments are not supported by this non-contractual draft calculation.`); return; }
        if (seenSalaryAdjustments.has(String(employee.id))) { errors.push(`Salary Cycle row ${index + 2}: this employee has more than one adjustment row.`); return; }
        if (adjustment !== 0 && !reason) { errors.push(`Salary Cycle row ${index + 2}: add a reason for the adjustment.`); return; }
        seenSalaryAdjustments.add(String(employee.id));
        salaryAdjustments.push({ employeeId: employee.id, adjustment, reason });
      });

      const previousSalary = [];
      const seenSalary = new Set();
      const savedSalaryCycles = new Set();
      const savedSalaryKeys = new Set();
      savedSalaryBatches.forEach((batch) => (batch.payments || []).forEach((payment) => {
        savedSalaryKeys.add([String(payment.employeeId), payment.salaryPeriodFrom, payment.salaryPeriodTo, payment.paymentDate, Number(payment.amount || 0).toFixed(2)].join("|"));
        savedSalaryCycles.add([String(payment.employeeId), payment.salaryPeriodFrom, payment.salaryPeriodTo].join("|"));
      }));
      sheetRows("Previous Salary").forEach((row, index) => {
        const amountRaw = rowValue(row, "Salary_Paid_Amount", "Amount");
        if (amountRaw === "" || amountRaw == null) return;
        const employee = findEmployee(row);
        const salaryPeriodFrom = normalizeDate(rowValue(row, "Salary_Period_From", "Salary Period From"));
        const salaryPeriodTo = normalizeDate(rowValue(row, "Salary_Period_To", "Salary Period To"));
        const paymentDate = normalizeDate(rowValue(row, "Payment_Date", "Payment Date"));
        const amount = amountValue(amountRaw);
        if (!employee || !salaryPeriodFrom || !salaryPeriodTo || !paymentDate || salaryPeriodFrom > salaryPeriodTo || salaryPeriodTo >= periodStart || paymentDate > asOfDate || !Number.isFinite(amount) || amount <= 0) {
          errors.push(`Previous Salary row ${index + 2}: enter an active employee, valid paid cycle, actual payment date through ${asOfDate}, and a positive amount.`);
          return;
        }
        const key = [String(employee.id), salaryPeriodFrom, salaryPeriodTo, paymentDate, amount.toFixed(2)].join("|");
        const cycleKey = [String(employee.id), salaryPeriodFrom, salaryPeriodTo].join("|");
        if (seenSalary.has(key) || savedSalaryKeys.has(key) || seenSalary.has(cycleKey) || savedSalaryCycles.has(cycleKey)) { errors.push(`Previous Salary row ${index + 2}: this employee and salary cycle already appear in this workbook or saved history.`); return; }
        seenSalary.add(key);
        seenSalary.add(cycleKey);
        previousSalary.push({ employeeId: employee.id, employeeName: employee.name, employeeType: employee.type, branch: employee.branch || "", salaryPeriodFrom, salaryPeriodTo, paymentDate, amount, paymentMode: String(rowValue(row, "Payment_Mode", "Payment Mode") || "Cash"), remarks: String(rowValue(row, "Remarks") || "") });
      });

      setSelectedSheets({
        Attendance: true,
        Advances: true,
        "Emergency Advances": false,
        "Salary Cycle": false,
        "Previous Salary": false,
      });
      const periodEndDate = new Date(`${periodEnd}T12:00:00`);
      const plannedPaymentDate = dateKey(new Date(periodEndDate.getFullYear(), periodEndDate.getMonth() + 1, 3));
      setPreview({ attendance, advances, noAdvanceConfirmations, salaryAdjustments, previousSalary, errors, fileName: file.name, employeeScope, employeeScopeLabel, cycle: { periodStart, periodEnd, asOfDate, plannedPaymentDate } });
    } catch (error) {
      alert(error?.message || "Could not read this Excel workbook.");
      setPreview(null);
    } finally {
      setWorking(false);
    }
  };

  const applyPreview = () => {
    if (!preview || selectedErrors.length || !Object.values(selectedSheets).some(Boolean)) return;
    const selectedPreview = {
      ...preview,
      attendance: selectedSheets.Attendance ? preview.attendance : [],
      advances: preview.advances.filter((entry) => entry.emergency?.toLowerCase() === "yes"
        ? selectedSheets["Emergency Advances"]
        : selectedSheets.Advances),
      noAdvanceConfirmations: selectedSheets.Advances ? preview.noAdvanceConfirmations : [],
      salaryAdjustments: selectedSheets["Salary Cycle"] ? preview.salaryAdjustments : [],
      previousSalary: selectedSheets["Previous Salary"] ? preview.previousSalary : [],
      selectedSheets: { ...selectedSheets },
      employeeScope: preview.employeeScope,
    };
    onSave?.(selectedPreview);
    setPreview(null);
  };

  const sheetErrorPrefixes = {
    Attendance: "Attendance row",
    Advances: "Advances row",
    "Emergency Advances": "Emergency Advances row",
    "Salary Cycle": "Salary Cycle row",
    "Previous Salary": "Previous Salary row",
  };
  const selectedErrors = (preview?.errors || []).filter((error) =>
    Object.entries(sheetErrorPrefixes).some(([sheet, prefix]) => selectedSheets[sheet] && error.startsWith(prefix))
      ? true
      : !Object.values(sheetErrorPrefixes).some((prefix) => error.startsWith(prefix))
  );
  const sheetLabels = ["Attendance", "Advances", "Emergency Advances", "Salary Cycle", "Previous Salary"];

  return (
    <div className="paper section" style={{ maxWidth: 1160, margin: "0 auto 40px", padding: 20 }}>
      <h1 style={{ margin: 0 }}>Smart Payroll Update</h1>
      <p style={{ color: "#5b6472", lineHeight: 1.5 }}>
        One workbook for attendance gaps, actual advances, any missed historical salary payments, and salary-register adjustments. Choose which active employees to include; saved entries are checked before import.
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))", gap: 12 }}>
        <label>Employee group<select value={employeeScope} onChange={(event) => { setEmployeeScope(event.target.value); setPreview(null); }} style={{ display: "block", width: "100%", marginTop: 5, padding: 9 }}><option value="non_contractual">Non-contractual</option><option value="contractual">Contractual</option><option value="all">All employees</option></select></label>
        <label>Salary period from<input type="date" value={periodStart} onChange={(event) => setPeriodStart(event.target.value)} style={{ display: "block", width: "100%", marginTop: 5, padding: 9 }} /></label>
        <label>Salary period to<input type="date" value={periodEnd} onChange={(event) => setPeriodEnd(event.target.value)} style={{ display: "block", width: "100%", marginTop: 5, padding: 9 }} /></label>
        <label>Attendance and advances through<input type="date" value={asOfDate} onChange={(event) => setAsOfDate(event.target.value)} style={{ display: "block", width: "100%", marginTop: 5, padding: 9 }} /></label>
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 16 }}>
        <button type="button" className="btn primary" onClick={downloadTemplate}>Download Excel template</button>
        <button type="button" className="btn" disabled={working} onClick={() => inputRef.current?.click()}>{working ? "Reading workbook…" : "Upload completed workbook"}</button>
        <button type="button" className="btn" onClick={onBack}>Back</button>
        <input ref={inputRef} type="file" accept=".xlsx,.xls" style={{ display: "none" }} onChange={handleFile} />
      </div>
      <p style={{ margin: "14px 0 0", fontSize: 13, color: "#64748b" }}>
        Attendance uses P, A, H, W, PH, or NJ. On Advances, enter 0 when you checked and no advance was taken; a blank means unchecked and stays a gap. Enter a positive amount only when paid; # marks an advance already saved. Emergency Advances is for paid off-schedule advances. Historical salary is imported only when a paid amount is supplied. Salary adjustments require a reason. No payment is recorded for the current cycle by this upload.
      </p>
      {preview && <section style={{ marginTop: 20, padding: 16, border: "1px solid #dbe3ed", borderRadius: 12, background: "#f8fafc" }}>
        <h2 style={{ margin: "0 0 8px", fontSize: 18 }}>Review before saving</h2>
        <p style={{ margin: "0 0 12px" }}>File: <b>{preview.fileName}</b>. Scope: <b>{preview.employeeScopeLabel}</b>. {preview.attendance.length} attendance marks, {preview.advances.length} actual advances, {preview.noAdvanceConfirmations.length} no-advance confirmations, {preview.previousSalary.length} missing historical salary payments, and {preview.salaryAdjustments.length} salary adjustments.</p>
        <fieldset style={{ border: "1px solid #cbd5e1", borderRadius: 10, padding: 12, margin: "12px 0" }}>
          <legend style={{ padding: "0 6px", fontWeight: 700 }}>Choose sheets to import</legend>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,220px),1fr))", gap: 8 }}>
            {sheetLabels.map((sheet) => <label key={sheet} style={{ display: "grid", gridTemplateColumns: "18px minmax(0,1fr)", alignItems: "center", justifyContent: "start", gap: 10, width: "100%", minWidth: 0, minHeight: 38, boxSizing: "border-box", padding: "6px 10px", border: "1px solid #dbe3ed", borderRadius: 8, cursor: "pointer", lineHeight: 1.3 }}>
              <input type="checkbox" checked={Boolean(selectedSheets[sheet])} onChange={(event) => setSelectedSheets((current) => ({ ...current, [sheet]: event.target.checked }))} style={{ width: 18, height: 18, minWidth: 18, margin: 0, justifySelf: "start", accentColor: "#2563eb" }} />
              {sheet}
            </label>)}
          </div>
          <small style={{ display: "block", marginTop: 8, color: "#64748b" }}>The sheet selection controls which workbook tabs are saved. The unpaid salary draft is recalculated only for non-contractual employees; contractual salary calculations remain under their separate rules. No salary payment is recorded by this upload.</small>
        </fieldset>
        {selectedErrors.length > 0 && <div role="alert" style={{ padding: 12, borderRadius: 8, background: "#fff1f2", color: "#9f1239" }}><b>Resolve these issues in the selected sheets before saving:</b><ul style={{ marginBottom: 0 }}>{selectedErrors.slice(0, 12).map((error, index) => <li key={index}>{error}</li>)}</ul>{selectedErrors.length > 12 && <p>And {selectedErrors.length - 12} more.</p>}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
          <button type="button" className="btn" onClick={() => setPreview(null)}>Cancel</button>
          <button type="button" className="btn primary" disabled={selectedErrors.length > 0 || !Object.values(selectedSheets).some(Boolean)} onClick={applyPreview}>Save selected updates</button>
        </div>
      </section>}
      <section style={{ marginTop: 22 }}>
        <h2 style={{ fontSize: 17 }}>Saved salary-cycle drafts</h2>
        {salaryDrafts.length === 0 ? <p style={{ color: "#64748b" }}>No draft has been created yet. It will appear here after a validated workbook is saved.</p> : salaryDrafts.map((draft) => {
          const hasPendingEdits = Object.keys(pendingDraftEdits).some((key) => key.startsWith(`${draft.id}|`));
          return <div key={draft.id} style={{ padding: 12, border: "1px solid #e2e8f0", borderRadius: 9, marginBottom: 12 }}>
          <b>{draft.periodStart} to {draft.periodEnd}</b> · payment planned {draft.plannedPaymentDate} · {draft.status || "Draft"} · {draft.employees?.length || 0} employees
          <p style={{ color: "#64748b", margin: "6px 0 10px" }}>Weekly bonus is already included. Adjust against your register here; this will remain unpaid until you record the real payment.</p>
          <p style={{ color: "#64748b", margin: "0 0 10px", fontSize: 13 }}>Enter the difference from the calculated amount and a reason. Save adjustments to keep them, or cancel edits to discard them. Removing this draft does not undo imported attendance or advances.</p>
          {draft.attendanceCoverageGaps > 0 && <p role="alert" style={{ color: "#9a3412", background: "#fff7ed", borderRadius: 8, padding: 10 }}>There are {draft.attendanceCoverageGaps} unmarked workdays in this cycle. Resolve those attendance gaps before treating these salary figures as final.</p>}
          <div style={{ overflowX: "auto" }}><table style={{ minWidth: 850, fontSize: 13 }}><thead><tr><th>Employee</th><th>Bonus days</th><th>Calculated net</th><th>Register adjustment</th><th>Reason</th><th>Adjusted draft</th></tr></thead><tbody>{(draft.employees || []).map((employee) => <tr key={employee.employeeId}>
            <td>{employee.employeeName}</td><td>{employee.bonusDays}</td><td>₹{Math.round(employee.calculatedNet).toLocaleString("en-IN")}</td>
            <td><input aria-label={`Adjustment for ${employee.employeeName}`} type="number" value={pendingDraftEdits[`${draft.id}|${employee.employeeId}`]?.adjustment ?? employee.adjustment ?? 0} onChange={(event) => setPendingDraftEdit(draft.id, employee.employeeId, { adjustment: event.target.value })} style={{ minWidth: 110 }} /></td>
            <td><input aria-label={`Adjustment reason for ${employee.employeeName}`} value={pendingDraftEdits[`${draft.id}|${employee.employeeId}`]?.adjustmentReason ?? employee.adjustmentReason ?? ""} onChange={(event) => setPendingDraftEdit(draft.id, employee.employeeId, { adjustmentReason: event.target.value })} style={{ minWidth: 160 }} /></td>
            <td><b>₹{Math.round(Number(employee.calculatedNet || 0) + Number(pendingDraftEdits[`${draft.id}|${employee.employeeId}`]?.adjustment ?? employee.adjustment ?? 0)).toLocaleString("en-IN")}</b></td>
          </tr>)}</tbody></table></div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap", marginTop: 12 }}>
            {hasPendingEdits && <><button type="button" className="btn" onClick={() => clearDraftEdits(draft.id)}>Cancel edits</button><button type="button" className="btn primary" onClick={() => saveDraftEdits(draft)}>Save adjustments</button></>}
            <button type="button" className="btn" onClick={() => removeDraft(draft)}>Remove salary draft</button>
          </div>
        </div>;})}
      </section>
    </div>
  );
}
