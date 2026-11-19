const User = require("../models/user_model");
const Department = require("../models/department_model");
const Designation = require("../models/designation_model");
const Store = require("../models/store_model");
const Role = require("../models/role_model");
const HRMSBranch = require("../models/hrms_branch_model");
const Shift = require("../models/shift_model");
const SalaryStructure = require("../models/salary_structure_model");
const Staff = require("../../models/Staff");
const XLSX = require("xlsx");
const bcrypt = require("bcrypt");
const { salaryStructureFromConfig, resolvePfRate } = require("../utils/salaryStructureFromConfig");
const { checkAccount, normalizePhone, PHONE_TAKEN_MESSAGE } = require("../../utils/accountUniqueness");
const { checkStaffLimit } = require("../../utils/planLimits");

// Excel dates arrive as serial numbers (45678) or as text ("15/08/1990",
// "1990-08-15"). Returns a Date, null for blank, or undefined if unreadable.
const parseSheetDate = (v) => {
  const s = String(v ?? "").trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (n > 59 && n < 2958466) return new Date(Math.round((n - 25569) * 86400000)); // Excel serial
    return undefined;
  }
  let m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/); // DD/MM/YYYY (Indian format)
  if (m) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
  m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2})$/); // DD/MM/YY — 00-26 → 20xx, else 19xx
  if (m) return new Date(Date.UTC(+m[3] + (+m[3] <= 26 ? 2000 : 1900), +m[2] - 1, +m[1]));
  m = s.match(/^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})/); // YYYY-MM-DD
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const d = new Date(s);
  return isNaN(d.getTime()) ? undefined : d;
};

// "25,000" / "₹ 25,000" / "Rs. 25000" → "25000" ("" stays ""), so amounts
// typed with separators aren't read as 25 by parseFloat / NaN by Number.
const cleanAmount = (v) => String(v ?? "").replace(/rs\.?|inr|₹|,|\s/gi, "");

// Allowed values of the User schema's payType / gender enums.
const PAY_TYPES = ["Monthly", "Weekly", "Daily", "Hourly"];
const GENDERS = ["Male", "Female", "Other"];

// "Yes"/"Y"/"true"/"1" → true, "No"/"N"/"false"/"0" → false, blank → undefined.
const parseYesNo = (v) => {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return undefined;
  if (["yes", "y", "true", "1"].includes(s)) return true;
  if (["no", "n", "false", "0"].includes(s)) return false;
  return undefined;
};

// "Fixed monthly" / "fixed_monthly" / "Fixed" → fixed_monthly; anything else with "day" → per_day.
const parsePfMode = (v) => {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return undefined;
  if (s.startsWith("fix")) return "fixed_monthly";
  if (s.includes("day")) return "per_day";
  return undefined;
};

// Employees imported without an email still need one: it is their login ID
// and is unique per company. ".invalid" is a reserved domain, so nothing is
// ever mailed to these.
const NO_EMAIL_DOMAIN = "no-email.invalid";

// "<mobile>@no-email.invalid" when there is a mobile (unique already, and
// usable as a login ID); otherwise the name, numbered until unused.
const placeholderEmail = async (mobile, name) => {
  if (mobile) return `${mobile}@${NO_EMAIL_DOMAIN}`;
  const base = String(name || "staff").toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.+|\.+$/g, "") || "staff";
  for (let n = 1; ; n++) {
    const email = `${base}${n > 1 ? `.${n}` : ""}@${NO_EMAIL_DOMAIN}`;
    if (!(await User.exists({ email })) && !(await Staff.exists({ email }))) return email;
  }
};

// "Sunday, Saturday" / "Sunday;Saturday" → ["Sunday", "Saturday"].
const parseList = (v) => String(v ?? "").split(/[,;/]/).map((d) => d.trim()).filter(Boolean);

// Build a name-or-id lookup: "morning shift" or "<ObjectId>" → _id.
const buildLookup = (docs) => {
  const map = new Map();
  docs.forEach((d) => {
    map.set(String(d._id), d._id);
    if (d.name) map.set(d.name.toLowerCase().trim(), d._id);
  });
  return (value) => (value ? map.get(String(value).toLowerCase().trim()) || map.get(String(value).trim()) || null : null);
};

/**
 * Creates HRMS employees (plus their linked CRM Staff login) from plain row
 * objects. Shared by the Excel import (rows = sheet rows, with an optional
 * column mapping) and the in-app "Bulk Add Staff" form (rows keyed by the
 * system field names directly). `rowNumber(i)` labels errors per source.
 */
async function importEmployeeRows(rawData, { req, mapping = null, rowNumber = (i) => i + 2, updateExisting = false }) {
    const tenant_id = req.user?.is_superadmin ? null : (req.user?.tenant_id || null);

    // 1. Fetch masters for lookup
    const [departments, designations, stores, roles, hrmsBranches, shifts] = await Promise.all([
      Department.find({ tenant_id }),
      Designation.find({ tenant_id }),
      Store.find({ tenant_id }),
      Role.find({ $or: [{ tenant_id }, { isSystemRole: true }] }),
      HRMSBranch.find({ tenant_id }).select("name"),
      Shift.find({ tenant_id }).select("name"),
    ]);

    const deptMap = new Map(departments.map(d => [d.name.toLowerCase().trim(), d._id]));
    const desigMap = new Map(designations.map(d => [d.name.toLowerCase().trim(), d._id]));
    const storeMap = new Map(stores.map(s => [s.name.toLowerCase().trim(), s._id]));
    // The in-app form sends ids; the Excel sheet sends names — accept both.
    departments.forEach(d => deptMap.set(String(d._id), d._id));
    designations.forEach(d => desigMap.set(String(d._id), d._id));
    let findBranch = buildLookup(hrmsBranches);
    const findShift = buildLookup(shifts);

    // Default role - usually "staff" or "employee"
    const staffRole = roles.find(r => r.role === "staff" || r.name?.toLowerCase() === "staff") || roles[0];

    const results = {
      success: 0, // new employees created
      updated: 0, // existing employees updated (updateExisting only)
      failed: 0,
      errors: [],
      warnings: [] // imported, but something was filled in or left out
    };

    // Helper to get value from row based on mapping or default key (with fuzzy matching)
    const getValue = (row, systemKey, defaultKey) => {
      const excelKey = mapping ? mapping[systemKey] : null;
      
      // 1. Try explicit mapping
      if (excelKey && excelKey !== "skip") {
        const val = row[excelKey];
        if (val !== undefined && val !== null) return val.toString().trim();
      }

      // 2. Try fuzzy match on defaultKey or systemKey
      const rowKeys = Object.keys(row);
      const findFuzzy = (k) => rowKeys.find(rk => 
        rk.toLowerCase().replace(/[*]/g, '').trim() === k.toLowerCase().replace(/[*]/g, '').trim()
      );

      const fuzzyKey = findFuzzy(defaultKey) || findFuzzy(systemKey);
      if (fuzzyKey) {
        const val = row[fuzzyKey];
        if (val !== undefined && val !== null) return val.toString().trim();
      }

      return "";
    };

    // Ensure a default "General" department exists for fallback
    let generalDept = departments.find(d => d.name.toLowerCase() === "general");
    if (!generalDept) {
      generalDept = await Department.findOneAndUpdate(
        { name: "General", tenant_id },
        { name: "General", code: "GEN001", isActive: true, tenant_id },
        { upsert: true, returnDocument: "after" }
      );
      deptMap.set("general", generalDept._id);
    }
    const generalDeptId = generalDept._id;

    // Mobiles taken by an earlier row of this same file.
    const filePhones = new Set();

    // Pre-validate that the sheet contains at least the Employee Name column
    if (Array.isArray(rawData) && rawData.length > 0) {
      const firstRow = rawData[0];
      const rowKeys = Object.keys(firstRow).map(k => k.toLowerCase().replace(/[*]/g, '').trim());
      const hasNameColumn = rowKeys.some(k =>
        ["name", "employeename", "employee name", "first name", "firstname", "full name", "fullname"].includes(k)
      );
      if (!hasNameColumn && !mapping?.name) {
        throw new Error("The uploaded sheet is missing the required 'Employee Name' column. Please check your sheet headers.");
      }
    }

    for (let i = 0; i < rawData.length; i++) {
      const row = rawData[i];
      // Notes about this row, kept only if the row imports.
      const rowWarnings = [];
      try {
        // The name may be one column or First Name + Last Name.
        const firstName = getValue(row, "firstName", "First Name");
        const lastName = getValue(row, "lastName", "Last Name");
        const name = getValue(row, "name", "Employee Name*") || [firstName, lastName].filter(Boolean).join(" ");
        const rawMobile = getValue(row, "mobile", "Mobile No*");
        let email = getValue(row, "email", "Email").toLowerCase();

        // Blank / title / "TOTAL" lines in company sheets: skip quietly
        // instead of reporting them as failed employees.
        if (!email && !rawMobile && (!name || /^(total|grand total|sub ?total)\b/i.test(name))) continue;
        if (!name) throw new Error(`Row ${rowNumber(i)}: Employee Name is required`);

        // Only the name is required. A malformed mobile is left out rather
        // than failing the row; a missing email gets a placeholder login ID.
        const normalized = normalizePhone(rawMobile);
        const mobile = normalized.error ? "" : normalized.phone;
        if (normalized.error) rowWarnings.push(`Row ${rowNumber(i)} (${name}): mobile "${rawMobile}" left out — ${normalized.error}`);
        if (!email) {
          email = await placeholderEmail(mobile, name);
          rowWarnings.push(`Row ${rowNumber(i)} (${name}): no email — login ID set to ${email}`);
        }

        // Existing email: either update that employee (Excel "Update existing"
        // option — e.g. re-importing an edited export) or reject the row.
        const existingUser = await User.findOne({ email });
        if (existingUser && !updateExisting) {
          throw new Error(`Row ${rowNumber(i)}: User with email ${email} already exists (tick "Update existing staff" to update them)`);
        }
        if (existingUser && String(existingUser.tenant_id || "") !== String(tenant_id || "")) {
          throw new Error(`Row ${rowNumber(i)}: ${email} belongs to another company`);
        }

        // Mapping and Sanitization using mapping helper
        const rawEmployeeCode = getValue(row, "employeeCode", "Code*");
        const employeeCode = rawEmployeeCode || `EMP${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 100)}`;
        // One email / one mobile = one account across every company
        // (utils/accountUniqueness.js). The mobile is optional here.
        const isOwnMobile = existingUser && mobile && normalizePhone(existingUser.mobile).phone === mobile;
        if (mobile && filePhones.has(mobile)) {
          throw new Error(`Row ${rowNumber(i)}: ${PHONE_TAKEN_MESSAGE} (${rawMobile})`);
        }
        if (!isOwnMobile) {
          const check = await checkAccount({
            kind: "user",
            email: existingUser ? undefined : email,
            phone: mobile || undefined,
            requirePhone: false,
            userId: existingUser?._id,
            staffId: existingUser?.staffId,
            tenantId: tenant_id || null,
          });
          if (!check.ok) throw new Error(`Row ${rowNumber(i)}: ${check.message}${check.field === "phone" && rawMobile ? ` (${rawMobile})` : ""}`);
        }
        const gender = getValue(row, "gender", "Gender*");
        
        const rawDeptName = getValue(row, "department", "Department Name*") || getValue(row, "department", "Department");
        const deptName = rawDeptName.toLowerCase().trim();
        
        const rawDesigName = getValue(row, "designation", "Designation Name*") || getValue(row, "designation", "Designation");
        const desigName = rawDesigName.toLowerCase().trim();
        
        const branchName = (getValue(row, "storeId", "Master Branch") || getValue(row, "storeId", "Punch In Branch")).toLowerCase().trim();
        const currentStoreId = storeMap.get(branchName) || (stores.length > 0 ? stores[0]._id : null);

        // --- Department & Designation Logic ---
        let departmentId = null;
        let designationId = null;

        // 1. Resolve Department
        if (deptName) {
          departmentId = deptMap.get(deptName);
          if (!departmentId) {
            // Auto-create missing department
            try {
              const newDept = new Department({
                name: rawDeptName,
                code: (rawDeptName.substring(0, 3).toUpperCase() + Math.floor(Math.random() * 1000)).padEnd(6, '0'),
                storeIds: currentStoreId ? [currentStoreId] : [],
                isActive: true,
                tenant_id,
              });
              const savedDept = await newDept.save();
              departmentId = savedDept._id;
              deptMap.set(deptName, departmentId);
              console.log(`[Import] Created new department: ${rawDeptName} -> ${departmentId}`);
            } catch (err) {
              console.error(`[Import] Failed to create department ${rawDeptName}:`, err.message);
            }
          }
        }

        // Final Fallback for Department
        if (!departmentId) {
          departmentId = generalDeptId;
          console.log(`[Import] Row ${rowNumber(i)}: No department found for "${rawDeptName}", falling back to General (${departmentId})`);
        }

        // 2. Resolve Designation
        if (desigName) {
          designationId = desigMap.get(desigName);
          if (!designationId) {
            // Auto-create missing designation
            try {
              const newDesig = new Designation({
                name: rawDesigName,
                // `code` is required by the schema — without it every
                // auto-created designation failed silently (left blank).
                code: (rawDesigName.replace(/[^a-z0-9]/gi, "").substring(0, 3).toUpperCase() + Math.floor(Math.random() * 1000)).padEnd(6, "0"),
                departmentId: departmentId,
                isActive: true,
                tenant_id,
              });
              const savedDesig = await newDesig.save();
              designationId = savedDesig._id;
              desigMap.set(desigName, designationId);
              console.log(`[Import] Created new designation: ${rawDesigName} -> ${designationId}`);
            } catch (err) {
              console.error(`[Import] Failed to create designation ${rawDesigName}:`, err.message);
            }
          }
        }

        const employmentTypeRaw = getValue(row, "employmentType", "Employment Type").toLowerCase();
        let employmentType = "permanent"; 
        if (employmentTypeRaw === "full time" || employmentTypeRaw === "permanent") employmentType = "permanent";
        else if (employmentTypeRaw === "contract") employmentType = "contract";
        else if (employmentTypeRaw === "intern") employmentType = "intern";
        else if (employmentTypeRaw === "probation") employmentType = "probation";

        // Match the User schema enums case-insensitively ("monthly" → "Monthly");
        // anything else is a clear row error rather than a Mongoose enum error.
        const rawPayType = getValue(row, "payType", "Salary Type*");
        const payType = rawPayType ? PAY_TYPES.find((p) => p.toLowerCase() === rawPayType.toLowerCase()) : "Monthly";
        if (!payType) {
          throw new Error(`Row ${rowNumber(i)}: Pay Type "${rawPayType}" must be Monthly, Weekly, Daily or Hourly — check the column mapping`);
        }
        const rawSalary = cleanAmount(getValue(row, "salaryAmount", "Salary"));
        const salaryAmount = parseFloat(rawSalary) || 0;
        const password = getValue(row, "password", "Password") || "12345678";

        const rawJoining = getValue(row, "joiningDate", "Date of Joining");
        const joiningDate = parseSheetDate(rawJoining);
        if (joiningDate === undefined) throw new Error(`Row ${rowNumber(i)}: Date of Joining "${rawJoining}" not understood — use DD/MM/YYYY`);
        const rawDob = getValue(row, "dob", "Date of Birth");
        const dob = parseSheetDate(rawDob);
        if (dob === undefined) throw new Error(`Row ${rowNumber(i)}: Date of Birth "${rawDob}" not understood — use DD/MM/YYYY`);

        // HRMS branch + shift (by name in Excel, by id from the in-app form)
        const rawBranch = getValue(row, "hrmsBranchId", "Branch");
        let hrmsBranchId = findBranch(rawBranch);
        if (rawBranch && !hrmsBranchId) {
          // Like departments: a branch the sheet names but that isn't set up yet is created.
          const branch = await HRMSBranch.findOneAndUpdate(
            { name: rawBranch, tenant_id },
            { $setOnInsert: { name: rawBranch, tenant_id } },
            { upsert: true, returnDocument: "after" }
          );
          hrmsBranches.push(branch);
          findBranch = buildLookup(hrmsBranches);
          hrmsBranchId = branch._id;
          results.warnings.push(`Branch "${rawBranch}" was not set up yet — created it`);
        }
        // A shift needs timings, so an unknown one can't be created — left blank instead.
        const rawShift = getValue(row, "shiftId", "Shift");
        const shiftId = findShift(rawShift);
        if (rawShift && !shiftId) rowWarnings.push(`Row ${rowNumber(i)} (${name}): shift "${rawShift}" not found — left blank`);

        // Salary breakdown + PF — only builds a SalaryStructure when any of
        // these columns is filled, so old-format sheets behave exactly as before.
        const basic = cleanAmount(getValue(row, "basic", "Basic"));
        const hra = cleanAmount(getValue(row, "hra", "HRA"));
        const pfApplicable = parseYesNo(getValue(row, "pfApplicable", "PF Applicable"));
        const pfMode = parsePfMode(getValue(row, "pfMode", "PF Mode"));
        const pfAmount = cleanAmount(getValue(row, "pfAmount", "PF Amount"));
        const esicAmount = cleanAmount(getValue(row, "esicAmount", "ESIC Amount"));
        const rawPfRate = getValue(row, "pfRate", "PF Rate (%)");
        const pfRate = resolvePfRate(rawPfRate);
        if (rawPfRate && pfRate === undefined) {
          throw new Error(`Row ${rowNumber(i)}: PF Rate "${rawPfRate}" must be a percentage between 0 and 100`);
        }
        // A Salary alone also creates a salary structure (Basic = Salary) —
        // without one, payroll skips the employee or pays ₹0.
        const hasSalaryColumns = [basic, hra, pfAmount, esicAmount, rawSalary].some((v) => v !== "") ||
          pfApplicable !== undefined || pfMode !== undefined || pfRate !== undefined;

        const userData = {
          employeeCode,
          name,
          email,
          mobile,
          password,
          gender: GENDERS.find((g) => g.toLowerCase() === String(gender || "").toLowerCase()) || "",
          department: departmentId,
          designation: designationId,
          storeId: currentStoreId,
          hrmsBranchId: hrmsBranchId || null,
          shiftId: shiftId || null,
          role: staffRole?._id,
          employmentType,
          payType,
          salaryAmount,
          joiningDate,
          dob,
          bankInfo: {
            bankName: getValue(row, "bankName", "Bank Name"),
            // Was falling back to the "Bank Name" column, filling the account
            // holder's name with the bank's name.
            accountName: getValue(row, "accountName", "Account Holder Name") || getValue(row, "accountName", "Account Name"),
            accountNumber: getValue(row, "accountNumber", "Account No") || getValue(row, "accountNumber", "Account Number"),
            ifscCode: getValue(row, "ifscCode", "IFSC Code"),
            branchCity: getValue(row, "branchCity", "Bank Branch") || getValue(row, "branchCity", "Bank Branch/City"),
          },
          emergencyContact: {
            name: getValue(row, "emergencyName", "Emergency Contact Name") || getValue(row, "emergencyName", "Emergency Name"),
            phone: getValue(row, "emergencyPhone", "Emergency Mobile") || getValue(row, "emergencyPhone", "Emergency Phone"),
            relation: getValue(row, "emergencyRelation", "Emergency Contact Relation") || getValue(row, "emergencyRelation", "Relation"),
          },
          address: {
            permanent: getValue(row, "permanentAddress", "Permanent Address") || getValue(row, "permanentAddress", "Current Address"),
            current: getValue(row, "currentAddress", "Current Address") || getValue(row, "permanentAddress", "Permanent Address"),
          },
          legalDocuments: {
            panNumber: getValue(row, "panNumber", "Pan Card No") || getValue(row, "panNumber", "PAN Number"),
            aadhaarNumber: getValue(row, "aadhaarNumber", "Aadhar Card No") || getValue(row, "aadhaarNumber", "Aadhaar Number"),
          },
          tenant_id,
        };
        // Columns the Setup > Staff template also carries. Blank cells are left
        // out so the schema defaults (e.g. attendance required) still apply.
        const extras = {
          attendanceRequired: parseYesNo(getValue(row, "attendanceRequired", "Attendance Required")),
          isActive: parseYesNo(getValue(row, "isActive", "Active")),
          weeklyHolidays: parseList(getValue(row, "weeklyHolidays", "Weekly Holidays")),
          bloodGroup: getValue(row, "bloodGroup", "Blood Group"),
          education: getValue(row, "education", "Education"),
          totalExperience: getValue(row, "totalExperience", "Experience"),
        };
        if (!extras.weeklyHolidays.length) delete extras.weeklyHolidays;
        Object.keys(extras).forEach((k) => (extras[k] === undefined || extras[k] === "") && delete extras[k]);
        Object.assign(userData, extras);

        // ── Update an existing employee: only cells that are filled in change ──
        if (existingUser) {
          const set = {};
          if (rawEmployeeCode) set.employeeCode = rawEmployeeCode;
          if (name) set.name = name;
          if (mobile) set.mobile = mobile;
          if (gender) set.gender = userData.gender;
          if (deptName) set.department = departmentId;
          if (desigName) set.designation = designationId;
          if (rawBranch) set.hrmsBranchId = hrmsBranchId;
          if (rawShift) set.shiftId = shiftId;
          if (employmentTypeRaw) set.employmentType = employmentType;
          if (rawPayType) set.payType = payType;
          if (rawSalary !== "") set.salaryAmount = salaryAmount;
          if (joiningDate) set.joiningDate = joiningDate;
          if (dob) set.dob = dob;
          Object.assign(set, extras);
          for (const group of ["bankInfo", "emergencyContact", "address", "legalDocuments"]) {
            for (const [k, v] of Object.entries(userData[group])) {
              if (v) set[`${group}.${k}`] = v;
            }
          }
          if (Object.keys(set).length) {
            await User.updateOne({ _id: existingUser._id }, { $set: set }, { runValidators: true });
          }

          // Salary breakdown / PF: patch only the given parts of their structure.
          if (hasSalaryColumns) {
            let structure = existingUser.salaryStructureId ? await SalaryStructure.findById(existingUser.salaryStructureId) : null;
            if (!structure) {
              structure = new SalaryStructure({
                name: `${name || existingUser.name || "Employee"}'s Salary Structure (${Date.now()}-${i})`,
                basic: 0, hra: 0, conveyance: 0, medicalAllowance: 0, specialAllowance: 0, isActive: true,
                standardDeductions: [{ name: "PF (Employee)", amount: 0 }, { name: "ESIC", amount: 0 }],
              });
            }
            if (basic !== "") structure.basic = Number(basic) || 0;
            else if (rawSalary !== "" && !(Number(structure.basic) > 0)) structure.basic = salaryAmount; // no breakdown yet → Basic = Salary
            if (hra !== "") structure.hra = Number(hra) || 0;
            if (pfRate !== undefined) structure.pfRate = pfRate;
            if (pfApplicable !== undefined) structure.pfApplicable = pfApplicable;
            if (pfMode !== undefined) structure.pfMode = pfMode;
            const setDeduction = (label, amount) => {
              const rest = (structure.standardDeductions || []).filter((d) => d.name !== label);
              structure.standardDeductions = [...rest, { name: label, amount: Number(amount) || 0 }];
            };
            if (pfAmount !== "") setDeduction("PF (Employee)", pfAmount);
            if (esicAmount !== "") {
              setDeduction("ESIC", esicAmount);
              structure.esicApplicable = Number(esicAmount) > 0;
            }
            await structure.save();
            if (!existingUser.salaryStructureId) {
              await User.updateOne({ _id: existingUser._id }, { $set: { salaryStructureId: structure._id } });
            }
          }

          // Keep the linked CRM login's name/phone in step (same as updateUser).
          if (name || mobile) {
            const linked = existingUser.staffId ? await Staff.findById(existingUser.staffId) : await Staff.findOne({ email, tenant_id: existingUser.tenant_id || null });
            if (linked) {
              if (name) {
                const parts = name.trim().split(/\s+/);
                linked.firstname = parts[0] || linked.firstname;
                linked.lastname = parts.slice(1).join(" ") || linked.lastname;
              }
              if (mobile) linked.phonenumber = mobile;
              await linked.save();
            }
          }

          if (mobile) filePhones.add(mobile);
          results.updated++;
          results.warnings.push(...rowWarnings);
          continue;
        }

        // Plan's Team Members limit: a new employee gets a staff login.
        const limitTenant = req.user?.tenant_id || req.user?.tenant?._id || null;
        if (!req.user?.is_superadmin && !(await Staff.exists({ email, tenant_id: limitTenant }))) {
          const seat = await checkStaffLimit(limitTenant);
          if (!seat.allowed) throw new Error(`${email}: ${seat.message}`);
        }

        let salaryStructureId = null;
        if (hasSalaryColumns) {
          const structure = await SalaryStructure.create({
            name: `${name || "Employee"}'s Salary Structure (${Date.now()}-${i})`,
            ...salaryStructureFromConfig({
              basic: { value: basic !== "" ? basic : rawSalary }, // no Basic column → Basic = Salary
              hra: { value: hra },
              // No PF Applicable column → legacy rule (on when an amount is given).
              pf: { value: pfAmount, mode: pfMode, isIncluded: pfApplicable, rate: pfRate },
              esic: { value: esicAmount },
            }),
            conveyance: 0,
            medicalAllowance: 0,
            specialAllowance: 0,
            isActive: true,
          });
          salaryStructureId = structure._id;
          userData.salaryStructureId = salaryStructureId;
        }

        const newUser = new User(userData);
        try {
          await newUser.save();
        } catch (saveErr) {
          if (salaryStructureId) await SalaryStructure.findByIdAndDelete(salaryStructureId);
          throw saveErr;
        }
        if (mobile) filePhones.add(mobile);

        // Link a CRM Staff login so this employee can sign in through the
        // normal staff login, same as single-employee creation does
        // (see user_controller.js createUser). Without this, a bulk-imported
        // employee has an HRMS User record but no way to authenticate at all,
        // since /api/auth/login only checks the Staff collection.
        try {
          // Same company only, and link both ways (staffId / hrms_user_id).
          const loginTenant = req.user?.tenant_id || req.user?.tenant?._id || null;
          const existingStaffLogin = await Staff.findOne({ email, tenant_id: loginTenant });
          if (existingStaffLogin) {
            if (!existingStaffLogin.hrms_user_id) await Staff.findByIdAndUpdate(existingStaffLogin._id, { hrms_user_id: newUser._id });
            await User.findByIdAndUpdate(newUser._id, { staffId: existingStaffLogin._id });
          } else {
            const nameParts = (name || "Employee").trim().split(/\s+/);
            const createdLogin = await Staff.create({
              firstname: firstName || nameParts[0] || "Employee",
              lastname: lastName || (firstName ? "" : nameParts.slice(1).join(" ")) || "User",
              email,
              password,
              phonenumber: mobile || "",
              admin: false,
              active: extras.isActive !== false,
              is_hrms_staff: true,
              tenant_id: loginTenant,
              hrms_user_id: newUser._id,
            });
            await User.findByIdAndUpdate(newUser._id, { staffId: createdLogin._id });
          }
        } catch (linkErr) {
          console.error("Failed to link imported employee to a CRM Staff login:", linkErr.message);
        }

        results.success++;
        results.warnings.push(...rowWarnings);
      } catch (error) {
        results.failed++;
        results.errors.push(error.message);
      }
    }

    return results;
}

// POST /api/import/bulk  (multipart: file = .xlsx, mapping = optional JSON {systemKey: excelColumn})
exports.bulkImportEmployees = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: "Please upload an Excel file" });
    }

    const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    const worksheet = workbook.Sheets[workbook.SheetNames[0]];
    // Row holding the column headers (0-based), detected by the import screen —
    // skips title rows such as "EMPLOYEE MASTER DATABASE AND PAYROLL - <site>".
    const headerRow = Math.max(0, parseInt(req.body.headerRow, 10) || 0);
    const rawData = XLSX.utils.sheet_to_json(worksheet, { range: headerRow, defval: "" });

    if (rawData.length === 0) {
      return res.status(400).json({ success: false, message: "The Excel file is empty" });
    }

    // Parse mapping if provided (sent as JSON string in multipart form)
    const mapping = req.body.mapping ? JSON.parse(req.body.mapping) : null;
    const updateExisting = req.body.updateExisting === "true" || req.body.updateExisting === true;
    const results = await importEmployeeRows(rawData, { req, mapping, updateExisting });

    res.status(200).json({
      success: true,
      message: `Import completed: ${results.success} added, ${results.updated} updated, ${results.failed} failed.`,
      data: results
    });

  } catch (error) {
    console.error("Bulk Import Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// POST /api/users/bulk-create  { rows: [{ name, email, mobile, department, hrmsBranchId, shiftId, ... }] }
// The in-app "Bulk Add Staff" grid — same validation and Staff-login linking as the Excel import.
exports.bulkCreateEmployees = async (req, res) => {
  try {
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
    if (rows.length === 0) {
      return res.status(400).json({ success: false, message: "Add at least one staff row" });
    }
    if (rows.length > 500) {
      return res.status(400).json({ success: false, message: "Up to 500 rows per bulk add — use Excel import for more" });
    }

    const results = await importEmployeeRows(rows, { req, rowNumber: (i) => i + 1 });
    res.status(200).json({
      success: true,
      message: `${results.success} added, ${results.failed} failed.`,
      data: results
    });
  } catch (error) {
    console.error("Bulk Create Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};
