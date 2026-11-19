/**
 * Service to handle complex financial calculations for invoices
 */
class InvoiceService {
  /**
   * Calculate invoice totals based on items, discounts, and adjustments
   * @param {Object} invoiceData - Original invoice data with items
   * @returns {Object} - Calculated totals (subtotal, total, discount_total)
   */
  static calculateTotals(invoiceData, client, homeState) {
    let subtotal = 0;
    let totalFreight = 0;
    let taxBeforeDiscount = 0;
    const { items, discount_percent = 0, adjustment = 0 } = invoiceData;

    if (items && Array.isArray(items)) {
      items.forEach((item) => {
        // A missing qty means the schema default of 1; an explicit 0 stays 0,
        // same as the invoice form (it used to be counted as 1).
        // Negative quantities, rates or freight are never valid (the API
        // rejects them); treat any that reach here as 0.
        const qty = item.qty === undefined || item.qty === null ? 1 : Math.max(Number(item.qty) || 0, 0);
        const itemSubtotal = qty * Math.max(Number(item.rate) || 0, 0);
        const itemFreight = Math.max(Number(item.freight_charge) || 0, 0);
        subtotal += itemSubtotal;
        totalFreight += itemFreight;

        // Freight is added to the line before GST — same taxable-value rule
        // the Purchase module uses (price + freight, then tax on top).
        const taxableValue = itemSubtotal + itemFreight;
        const taxRate = InvoiceService.itemTaxRate(item);
        if (taxRate) {
          taxBeforeDiscount += (taxableValue * taxRate) / 100;
        }
      });
    }

    // "fixed" discounts are a money amount (discount_fixed); otherwise
    // discount_percent is a percentage of the subtotal.
    let discount_total = 0;
    if (invoiceData.discount_type === "fixed") {
      discount_total = Math.max(Number(invoiceData.discount_fixed) || 0, 0);
    } else if (invoiceData.discount_type !== "no_discount" && Number(discount_percent) > 0) {
      discount_total = (subtotal * Math.min(Number(discount_percent), 100)) / 100;
    }
    discount_total = Math.min(discount_total, subtotal);
    const discountFactor = subtotal > 0 ? 1 - discount_total / subtotal : 1;

    // Tax is charged on the discounted amount, not the pre-discount subtotal —
    // since the discount applies uniformly, scaling the pre-discount tax by
    // the same factor is equivalent to (and cheaper than) re-taxing each item.
    const totalTax = taxBeforeDiscount * discountFactor;

    const total = subtotal + totalFreight + totalTax - discount_total + (Number(adjustment) || 0);

    // Split taxes using gstService
    const { HOME_STATE, HOME_STATE_GST_CODE, detectStateFromAddress } = require("../utils/gstHomeState");
    const gstService = require("./gstService");

    // The intra/inter-state determination compares the buyer's state to the
    // SELLING company's own state — defaults to the original pilot tenant's
    // Gujarat, but a caller (e.g. Ekagra's Bihar) can override it.
    const homeStateName = (homeState?.name || HOME_STATE).toLowerCase();
    const homeStateCode = homeState?.code || HOME_STATE_GST_CODE;

    let placeOfSupplyStateCode = "00";
    if (client) {
      const gstin = String(client.gst_number || "").trim();
      if (/^\d{2}/.test(gstin)) {
        placeOfSupplyStateCode = gstin.substring(0, 2);
      } else {
        let clientState = String(client.billing_state || client.state || "").trim();
        if (!clientState) {
          const address = `${client.billing_street || ""} ${client.address || ""}`;
          clientState = detectStateFromAddress(address);
        }
        if (clientState && clientState.toLowerCase() === homeStateName) {
          placeOfSupplyStateCode = homeStateCode;
        }
      }
    }

    const split = gstService.splitTax({
      gstAmount: totalTax,
      companyStateCode: homeStateCode,
      placeOfSupplyStateCode,
    });

    const isHomeState = String(placeOfSupplyStateCode) === String(homeStateCode);

    const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
    return {
      subtotal: round2(subtotal),
      total_freight: round2(totalFreight),
      // total_tax is the Invoice/Estimate field name; totalTax kept for older callers.
      total_tax: round2(totalTax),
      totalTax: round2(totalTax),
      discount_total: round2(discount_total),
      total: round2(total),
      tax_type: isHomeState ? "GST" : "IGST",
      total_cgst: split.cgst,
      total_sgst: split.sgst,
      total_igst: split.igst,
    };
  }

  // The tax picked on the line wins, even "Zero" (0%); GST % is used only
  // when no tax was sent at all — the same rule the invoice form uses.
  static itemTaxRate(item) {
    const hasTax = item.tax !== undefined && item.tax !== null && item.tax !== "";
    return (hasTax ? Number(item.tax) : Number(item.gstPercentage)) || 0;
  }

  /**
   * Update invoice status based on payments.
   * Also closes any Credit Notes that have been fully consumed.
   * @param {string} invoiceId 
   */
  static async updateStatus(invoiceId) {
    const Invoice = require("../models/Invoice");
    const Payment = require("../models/Payment");
    const CreditNote = require("../models/CreditNote");

    const invoice = await Invoice.findById(invoiceId);
    if (!invoice) return;

    const payments = await Payment.find({ invoice: invoiceId });
    const totalPaid = payments.reduce((sum, p) => sum + p.amount, 0);

    // A cancelled invoice stays cancelled whatever happens to its payments,
    // and with nothing paid a draft / sent / overdue invoice keeps its status.
    if (invoice.status === "cancelled") return;
    const KEEP_WHEN_UNPAID = ["draft", "sent", "sent_later", "overdue", "unpaid"];

    let newStatus;
    if (totalPaid <= 0) {
      newStatus = KEEP_WHEN_UNPAID.includes(invoice.status) ? invoice.status : "unpaid";
    } else if (totalPaid < invoice.total - 0.005) {
      newStatus = "partially_paid";
    } else {
      newStatus = "paid";
    }

    if (invoice.status !== newStatus) {
      invoice.status = newStatus;
      await invoice.save();
    }

    // If invoice is now fully paid, check if any Credit Notes linked to this invoice
    // have been fully consumed, and close them automatically.
    if (newStatus === "paid") {
      const creditNotePayments = payments.filter(p => p.paymentmode === "Credit Note");
      if (creditNotePayments.length > 0) {
        // Find all open credit notes that have this invoice in invoices_credited
        const openCreditNotes = await CreditNote.find({
          status: 1, // open
          "invoices_credited.invoice": invoiceId
        });

        for (const cn of openCreditNotes) {
          const totalApplied = (cn.invoices_credited || []).reduce(
            (sum, item) => sum + (item.amount || 0), 0
          );
          if (totalApplied >= cn.total) {
            cn.status = 2; // Closed
            await cn.save();
          }
        }
      }
    }
  }
}

module.exports = InvoiceService;
