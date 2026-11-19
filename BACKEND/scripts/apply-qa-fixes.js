const fs = require("fs");
const path = require("path");

// Fix 1: item_controller.js
const itemControllerPath = path.join(__dirname, "../src/controllers/item_controller.js");
let lines = fs.readFileSync(itemControllerPath, "utf8").split(/\r?\n/);
if (!lines.slice(0, 10).some(l => l.includes("PurchaseCategory"))) {
  lines.splice(3, 0, 'const PurchaseCategory = require("../models/PurchaseCategory");');
  fs.writeFileSync(itemControllerPath, lines.join("\r\n"), "utf8");
  console.log("✓ Added PurchaseCategory to top of item_controller.js");
}

// Fix 2: payroll_controller.js - weekly off calculation for absent periods
const payrollControllerPath = path.join(__dirname, "../src/hrms/controllers/payroll_controller.js");
let payrollContent = fs.readFileSync(payrollControllerPath, "utf8");
const targetWeeklyOff = `      const workedAnyDay = presentDays + paidLeaveDays > 0;
      let paidWeeklyOffs = 0;
      if (workedAnyDay) {
        for (let d = 1; d <= elapsedDays; d++) {
          if (targetDays.includes(new Date(year, month - 1, d).getDay())) paidWeeklyOffs++;
        }
      }`;

const replacementWeeklyOff = `      const workedAnyDay = presentDays + paidLeaveDays > 0;
      let paidWeeklyOffs = 0;
      if (workedAnyDay) {
        const attendedDates = new Set();
        attendance.forEach(a => {
          if (a.status === "Full Day" || a.status === "Half Day") attendedDates.add(String(a.date));
        });
        leaves.forEach(l => {
          if (l.leaveTypeId && l.leaveTypeId.isPaid) {
            const lStart = l.fromDate < startDate ? startDate : l.fromDate;
            const lEnd = l.toDate > endDate ? endDate : l.toDate;
            for (let d = new Date(lStart.getFullYear(), lStart.getMonth(), lStart.getDate()); d <= lEnd; d.setDate(d.getDate() + 1)) {
              const y = d.getFullYear();
              const m = String(d.getMonth() + 1).padStart(2, "0");
              const day = String(d.getDate()).padStart(2, "0");
              attendedDates.add(\`\${y}-\${m}-\${day}\`);
            }
          }
        });

        for (let d = 1; d <= elapsedDays; d++) {
          const dt = new Date(year, month - 1, d);
          if (!targetDays.includes(dt.getDay())) continue;

          const dtStr = \`\${year}-\${String(month).padStart(2, "0")}-\${String(d).padStart(2, "0")}\`;
          if (attendedDates.has(dtStr)) {
            paidWeeklyOffs++;
            continue;
          }

          let precedingWorkingAttended = false;
          for (let p = d - 1; p >= 1; p--) {
            const pDate = new Date(year, month - 1, p);
            if (!targetDays.includes(pDate.getDay())) {
              const pStr = \`\${year}-\${String(month).padStart(2, "0")}-\${String(p).padStart(2, "0")}\`;
              if (attendedDates.has(pStr)) precedingWorkingAttended = true;
              break;
            }
          }

          let followingWorkingAttended = false;
          for (let f = d + 1; f <= totalDaysInMonth; f++) {
            const fDate = new Date(year, month - 1, f);
            if (!targetDays.includes(fDate.getDay())) {
              const fStr = \`\${year}-\${String(month).padStart(2, "0")}-\${String(f).padStart(2, "0")}\`;
              if (attendedDates.has(fStr)) followingWorkingAttended = true;
              break;
            }
          }

          if (precedingWorkingAttended || followingWorkingAttended) {
            paidWeeklyOffs++;
          }
        }
      }`;

const normContent = payrollContent.replace(/\r\n/g, "\n");
const normTarget = targetWeeklyOff.replace(/\r\n/g, "\n");
if (normContent.includes(normTarget)) {
  const updated = normContent.replace(normTarget, replacementWeeklyOff.replace(/\r\n/g, "\n"));
  fs.writeFileSync(payrollControllerPath, updated.replace(/\n/g, "\r\n"), "utf8");
  console.log("✓ Updated weekly off calculation in payroll_controller.js");
} else {
  console.log("Weekly off target not found or already updated");
}
