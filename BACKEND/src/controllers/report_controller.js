const Invoice = require("../models/Invoice");
const Expense = require("../models/Expense");
const Payment = require("../models/Payment");
const CreditNote = require("../models/CreditNote");
const Proposal = require("../models/Proposal");
const Estimate = require("../models/Estimate");
const Client = require("../models/Client");
const Item = require("../models/Item");
const Purchase = require("../models/Purchase");
const { resolveProposalNames } = require("./proposal_controller");

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const getFinancialReport = async (req, res) => {
  try {
    const { fromDate, toDate } = req.query;
    const dateQuery = {};
    if (fromDate || toDate) {
      dateQuery.date = {};
      if (fromDate) dateQuery.date.$gte = new Date(fromDate);
      if (toDate) dateQuery.date.$lte = new Date(toDate);
    }
    if (!req.user?.is_superadmin && req.user?.tenant_id) dateQuery.tenant_id = req.user.tenant_id;

    const invoices = await Invoice.find(dateQuery);
    const payments = await Payment.find(dateQuery);
    const expenses = await Expense.find(dateQuery);

    const totalInvoiced = invoices.reduce((sum, inv) => sum + inv.total, 0);
    const totalPaid = payments.reduce((sum, p) => sum + p.amount, 0);
    const totalExpenses = expenses.reduce((sum, e) => sum + e.amount, 0);

    res.json({
      totalInvoiced,
      totalPaid,
      totalExpenses,
      netProfit: totalPaid - totalExpenses,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getSalesReport = async (req, res) => {
  try {
    const { currency = "USD", period = "all_time", fromDate, toDate } = req.query;

    // 1. Resolve date query based on period
    const dateQuery = {};
    const now = new Date();
    
    if (period === "this_month") {
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
      dateQuery.date = { $gte: startOfMonth, $lte: endOfMonth };
    } else if (period === "last_month") {
      const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
      dateQuery.date = { $gte: startOfLastMonth, $lte: endOfLastMonth };
    } else if (period === "this_quarter") {
      const quarter = Math.floor(now.getMonth() / 3);
      const startOfQuarter = new Date(now.getFullYear(), quarter * 3, 1);
      const endOfQuarter = new Date(now.getFullYear(), (quarter + 1) * 3, 0, 23, 59, 59, 999);
      dateQuery.date = { $gte: startOfQuarter, $lte: endOfQuarter };
    } else if (period === "this_year") {
      const startOfYear = new Date(now.getFullYear(), 0, 1);
      const endOfYear = new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999);
      dateQuery.date = { $gte: startOfYear, $lte: endOfYear };
    } else if (period === "custom" && (fromDate || toDate)) {
      dateQuery.date = {};
      if (fromDate) dateQuery.date.$gte = new Date(fromDate);
      if (toDate) dateQuery.date.$lte = new Date(toDate);
    }

    // 2. Fetch real database items matching the currency and date ranges
    const invoices = await Invoice.find({ ...dateQuery, currency })
      .populate({
        path: "client",
        select: "company firstname lastname groups",
        populate: { path: "groups", select: "name" },
      });

    const payments = await Payment.find(dateQuery).populate({
      path: "invoice",
      match: { currency }
    });
    // Filter out payments that don't have matching currency
    const filteredPayments = payments.filter(p => p.invoice);

    const creditNotes = await CreditNote.find({ ...dateQuery, currency })
      .populate("client", "company firstname lastname");

    // Proposal.rel_id is a polymorphic ref (customer/lead) with no populate path —
    // resolveProposalNames batch-resolves a display name instead of .populate("client").
    const proposals = await Proposal.find(dateQuery);
    await resolveProposalNames(proposals);

    const estimates = await Estimate.find(dateQuery)
      .populate("client", "company firstname lastname");

    // 3. Build sub-report arrays
    // A. Invoices Report
    const invoicesReport = invoices.map(inv => ({
      _id: inv._id,
      number: inv.number,
      clientName: inv.client ? (inv.client.company || `${inv.client.firstname} ${inv.client.lastname}`) : "N/A",
      date: inv.date,
      duedate: inv.duedate,
      subtotal: inv.subtotal,
      total: inv.total,
      total_tax: inv.total_tax || 0,
      status: inv.status
    }));

    // B. Items Report (aggregate from invoices)
    const itemsMap = {};
    invoices.forEach(inv => {
      if (inv.items && inv.items.length > 0) {
        inv.items.forEach(it => {
          const name = it.description || "Unnamed Item";
          if (!itemsMap[name]) {
            itemsMap[name] = { name, qty: 0, totalRevenue: 0 };
          }
          itemsMap[name].qty += it.qty || 1;
          itemsMap[name].totalRevenue += (it.rate || 0) * (it.qty || 1);
        });
      }
    });
    const itemsReport = Object.values(itemsMap).map((it) => ({
      name: it.name,
      qtySold: it.qty,
      avgPrice: it.qty > 0 ? (it.totalRevenue / it.qty) : 0,
      totalRevenue: it.totalRevenue
    }));

    // C. Payments Received
    const paymentsReport = filteredPayments.map(p => ({
      _id: p._id,
      paymentId: p.paymentid || p._id.toString().substring(0, 8).toUpperCase(),
      invoiceNumber: p.invoice ? p.invoice.number : "N/A",
      paymentMode: p.paymentmode || "Bank Transfer",
      transactionId: p.transactionid || "TXN-" + p._id.toString().substring(16).toUpperCase(),
      date: p.date,
      amount: p.amount
    }));

    // D. Credit Notes Report
    const creditNotesReport = creditNotes.map(cn => ({
      _id: cn._id,
      number: cn.number || "CN-" + cn._id.toString().substring(0, 6).toUpperCase(),
      clientName: cn.client ? (cn.client.company || `${cn.client.firstname} ${cn.client.lastname}`) : "N/A",
      date: cn.date,
      total: cn.total,
      remaining: cn.remaining_amount ?? cn.total,
      status: cn.status || "active"
    }));

    // E. Proposals Report
    const proposalsReport = proposals.map(prop => ({
      _id: prop._id,
      number: prop.number || "PROP-" + prop._id.toString().substring(0, 6).toUpperCase(),
      subject: prop.subject,
      clientName: prop.proposal_to || "N/A",
      date: prop.date,
      openTill: prop.open_till,
      subtotal: prop.subtotal || 0,
      total: prop.total || 0,
      status: prop.status || "draft"
    }));

    // F. Estimates Report
    const estimatesReport = estimates.map(est => ({
      _id: est._id,
      number: est.number,
      reference: est.reference || "REF-" + est._id.toString().substring(0, 6).toUpperCase(),
      clientName: est.client ? (est.client.company || `${est.client.firstname} ${est.client.lastname}`) : "N/A",
      date: est.date,
      expiryDate: est.expirydate,
      subtotal: est.subtotal || 0,
      total: est.total || 0,
      status: est.status || "draft"
    }));

    // G. Customers Report (summary per client)
    const customersMap = {};
    invoices.forEach(inv => {
      const clientName = inv.client ? (inv.client.company || `${inv.client.firstname} ${inv.client.lastname}`) : "N/A";
      const clientId = inv.client ? inv.client._id.toString() : "N/A";
      if (!customersMap[clientId]) {
        customersMap[clientId] = { name: clientName, invoiced: 0, paid: 0 };
      }
      customersMap[clientId].invoiced += inv.total;
      if (inv.status === "paid") {
        customersMap[clientId].paid += inv.total;
      } else if (inv.status === "partially_paid") {
        customersMap[clientId].paid += (inv.total / 2);
      }
    });
    const customersReport = Object.values(customersMap).map((c) => ({
      clientName: c.name,
      totalInvoiced: c.invoiced,
      totalPaid: c.paid,
      balance: c.invoiced - c.paid
    }));

    // 4. Build Charts Data from the real invoices/payments already fetched above
    // Bucket by "YYYY-MM" (not just a month label) so different years don't collapse together.
    const monthBuckets = {};
    invoices.forEach(inv => {
      const d = inv.date ? new Date(inv.date) : null;
      if (!d || isNaN(d.getTime())) return;
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      monthBuckets[key] = (monthBuckets[key] || 0) + (inv.total || 0);
    });
    const incomeTrend = Object.keys(monthBuckets)
      .sort()
      .map(key => {
        const [y, m] = key.split("-");
        return { label: `${MONTH_LABELS[Number(m) - 1]} ${y}`, amount: monthBuckets[key] };
      });

    const paymentModeBuckets = {};
    filteredPayments.forEach(p => {
      const mode = (p.paymentmode || "").trim() || "Unspecified";
      paymentModeBuckets[mode] = (paymentModeBuckets[mode] || 0) + (p.amount || 0);
    });
    const paymentModesDistribution = Object.entries(paymentModeBuckets).map(([name, value]) => ({ name, value }));

    // Bucketed by each invoice's client's first assigned group (a client can belong to
    // several groups — attributing to all of them would make slices sum past the real total).
    const groupBuckets = {};
    invoices.forEach(inv => {
      const groupName = inv.client?.groups?.[0]?.name || "Ungrouped";
      groupBuckets[groupName] = (groupBuckets[groupName] || 0) + (inv.total || 0);
    });
    const customerGroupsDistribution = Object.entries(groupBuckets).map(([name, value]) => ({ name, value }));

    res.json({
      invoicesReport,
      itemsReport,
      paymentsReport,
      creditNotesReport,
      proposalsReport,
      estimatesReport,
      customersReport,
      charts: {
        incomeTrend,
        paymentModesDistribution,
        customerGroupsDistribution
      }
    });

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getExpensesReport = async (req, res) => {
  try {
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const excludeBillable = req.query.excludeBillable === "true";

    const startOfYear = new Date(year, 0, 1);
    const endOfYear = new Date(year, 11, 31, 23, 59, 59, 999);

    // Build main table query matching date
    const allExpenses = await Expense.find({ date: { $gte: startOfYear, $lte: endOfYear } });
    const expenses = excludeBillable ? allExpenses.filter(e => e.billable !== true) : allExpenses;

    // Categories list: seed default ones to match UI Mockups perfectly
    const defaultCategories = ["Bathroom Accessories", "Salary Calculation", "Office Supplies", "Travel & Meals", "IT & Software"];
    
    // Find all distinct categories present in db plus the default ones
    const dbCategories = await Expense.distinct("category", { date: { $gte: startOfYear, $lte: endOfYear } });
    const allCategoryNames = Array.from(new Set([...defaultCategories, ...dbCategories])).filter(Boolean);

    // Build matrix data: 12 months (0 to 11) for each category
    const categoriesReport = allCategoryNames.map(catName => {
      const months = Array(12).fill(0);
      const catExpenses = expenses.filter(e => e.category === catName);
      
      catExpenses.forEach(e => {
        const m = new Date(e.date).getMonth();
        if (m >= 0 && m < 12) {
          months[m] += e.amount;
        }
      });

      const total = months.reduce((a, b) => a + b, 0);

      return {
        name: catName,
        months,
        total
      };
    });

    // Sum overall net subtotal, tax and totals per month
    const netAmountSubtotal = Array(12).fill(0);
    const totalTax = Array(12).fill(0);
    const overallTotal = Array(12).fill(0);

    expenses.forEach(e => {
      const m = new Date(e.date).getMonth();
      if (m >= 0 && m < 12) {
        const amt = e.amount || 0;
        const tx = e.tax || 0;
        netAmountSubtotal[m] += amt - tx;
        totalTax[m] += tx;
        overallTotal[m] += amt;
      }
    });

    // Now, build Billable vs Non-Billable charts data
    const chartExpenses = allExpenses;

    const billableExpenses = chartExpenses.filter(e => e.billable === true);
    const nonBillableExpenses = chartExpenses.filter(e => e.billable !== true);

    const billableMap = {};
    billableExpenses.forEach(e => {
      billableMap[e.category] = (billableMap[e.category] || 0) + e.amount;
    });

    const nonBillableMap = {};
    nonBillableExpenses.forEach(e => {
      nonBillableMap[e.category] = (nonBillableMap[e.category] || 0) + e.amount;
    });

    let billableByCategory = Object.keys(billableMap).map(name => ({
      name,
      value: billableMap[name]
    }));
    let nonBillableByCategory = Object.keys(nonBillableMap).map(name => ({
      name,
      value: nonBillableMap[name]
    }));

    res.json({
      year,
      excludeBillable,
      categoriesReport,
      netAmountSubtotal,
      totalTax,
      overallTotal,
      overallTotalYear: overallTotal.reduce((a, b) => a + b, 0),
      expenses: expenses.map(e => ({
        _id: e._id,
        category: e.category,
        amount: e.amount,
        tax: e.tax || 0,
        date: e.date,
        reference_no: e.reference_no || "N/A",
        note: e.note || "",
        billable: e.billable || false
      })),
      charts: {
        billableByCategory,
        nonBillableByCategory
      }
    });

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getPurchaseReport = async (req, res) => {
  try {
    const { period = "all_time", fromDate, toDate } = req.query;

    const dateQuery = {};
    const now = new Date();

    if (period === "this_month") {
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
      dateQuery.bill_date = { $gte: startOfMonth, $lte: endOfMonth };
    } else if (period === "last_month") {
      const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
      dateQuery.bill_date = { $gte: startOfLastMonth, $lte: endOfLastMonth };
    } else if (period === "this_quarter") {
      const quarter = Math.floor(now.getMonth() / 3);
      const startOfQuarter = new Date(now.getFullYear(), quarter * 3, 1);
      const endOfQuarter = new Date(now.getFullYear(), (quarter + 1) * 3, 0, 23, 59, 59, 999);
      dateQuery.bill_date = { $gte: startOfQuarter, $lte: endOfQuarter };
    } else if (period === "this_year") {
      const startOfYear = new Date(now.getFullYear(), 0, 1);
      const endOfYear = new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999);
      dateQuery.bill_date = { $gte: startOfYear, $lte: endOfYear };
    } else if (period === "custom" && (fromDate || toDate)) {
      dateQuery.bill_date = {};
      if (fromDate) dateQuery.bill_date.$gte = new Date(fromDate);
      if (toDate) dateQuery.bill_date.$lte = new Date(toDate);
    }

    if (!req.user?.is_superadmin && req.user?.tenant_id) {
      dateQuery.tenant_id = req.user.tenant_id;
    }

    const purchases = await Purchase.find(dateQuery).sort({ bill_date: -1 });

    const purchasesReport = purchases.map((p) => ({
      _id: p._id,
      bill_no: p.bill_no,
      supplier_name: p.supplier_name,
      bill_date: p.bill_date,
      due_date: p.due_date,
      quantity: p.quantity,
      rate: p.rate,
      amount: p.amount,
      gst_rate: p.gst_rate,
      total: p.total,
      payment_status: p.payment_status,
    }));

    let totalPurchaseAmount = 0;
    let totalPaid = 0;
    let totalOutstanding = 0;
    let totalGST = 0;

    purchases.forEach((p) => {
      const total = p.total || 0;
      totalPurchaseAmount += total;
      if (p.payment_status === "Paid") {
        totalPaid += total;
      } else {
        totalOutstanding += total;
      }
      totalGST += (p.cgst || 0) + (p.sgst || 0) + (p.igst || 0);
    });

    const kpis = {
      totalPurchaseAmount,
      totalPaid,
      totalOutstanding,
      totalGST,
      count: purchases.length,
    };

    const monthBuckets = {};
    purchases.forEach((p) => {
      const d = p.bill_date ? new Date(p.bill_date) : null;
      if (!d || isNaN(d.getTime())) return;
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      monthBuckets[key] = (monthBuckets[key] || 0) + (p.total || 0);
    });

    const purchaseTrend = Object.keys(monthBuckets)
      .sort()
      .map((key) => {
        const [y, m] = key.split("-");
        return { label: `${MONTH_LABELS[Number(m) - 1]} ${y}`, amount: monthBuckets[key] };
      });

    const supplierBuckets = {};
    purchases.forEach((p) => {
      const supplierName = p.supplier_name || "Unknown";
      supplierBuckets[supplierName] = (supplierBuckets[supplierName] || 0) + (p.total || 0);
    });

    const supplierDistribution = Object.entries(supplierBuckets).map(([name, value]) => ({
      name,
      value,
    }));

    res.json({
      purchasesReport,
      kpis,
      purchaseTrend,
      supplierDistribution,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = { getFinancialReport, getSalesReport, getExpensesReport, getPurchaseReport };
