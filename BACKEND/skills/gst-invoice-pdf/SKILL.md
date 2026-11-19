---
name: gst-invoice-pdf
description: Generates a formatted GST invoice, quotation, or proposal PDF matching Fuerte CRM's standard corporate layout, with a correct CGST/SGST or IGST tax breakdown. Use when the user asks to create, export, download, print, or generate a PDF for an invoice, quotation, or proposal.
---

# GST Invoice/Quotation PDF Generation

This Skill supplies the tax-calculation rules and exact layout Fuerte CRM's
documents use. It does not generate PDFs by itself — pair it with
Anthropic's pre-built `pdf` Skill (or `docx` if the user wants an editable
version) to actually produce the file. This Skill's job is making sure the
numbers and layout are *correct*, not the file-writing mechanics.

## Where the source data comes from

Never invent invoice data. Use the CRM's own tools first:
1. `search_records` or `verify_record` (module: `invoice`, `quotation`, or
   `proposal`) to find the record and confirm it has no missing fields.
2. The record's `items` array, `subtotal`, `discount_percent`, `adjustment`,
   `total_tax`, and `total` fields are the source of truth — read them, do
   not recompute subtotal/total yourself unless the user is asking you to
   draft a brand-new document that hasn't been saved yet.

## Tax split: CGST+SGST vs IGST

This is the part that's easy to get wrong — always determine it explicitly,
never guess:

- **Same state** (seller's state == buyer's/recipient's state): split the
  total tax amount into two equal halves — **SGST/UTGST** (50%) and
  **CGST** (50%).
- **Different state** (inter-state): the full tax amount is **IGST**
  (100%), not split.
- The seller's state comes from the tenant's company address (Settings).
  The buyer's state comes from the Client/Lead record's `state` field. If
  either is missing, ask rather than assume same-state.

## Rounding

Round the final total to the nearest whole rupee. If the rounding
adjustment is non-zero, show it as its own line item (e.g. `-₹0.38`) rather
than silently absorbing it into the total — this must be visible and must
reconcile: `untaxed_amount + tax + adjustment + rounding == displayed_total`.

## Document layout (match exactly — this is the house style)

```
[Icon]  <Invoice/Quotation Number>   <STATUS badge>
        <DOCUMENT TYPE LABEL, e.g. "CORPORATE INVOICE">
                                                    [Download PDF button]
─────────────────────────────────────────────────────────────
┌─ RECIPIENT INFORMATION ──────┐  ┌─ SUMMARY ──────────────┐
│ <Recipient name or "N/A">    │  │ FROM                    │
│ [GSTIN: <recipient GSTIN>]   │  │ <Company name>          │
└───────────────────────────────┘  │ <Company address>      │
                                    │                         │
# | ITEM DESCRIPTION | QTY | RATE | TAX | AMOUNT              │ INVOICE INFORMATION
1 | ...                                                        │ Status: <status>
2 | ...                                                        │ Date: <date>
                                                                 │ Due Date: <due date or "-">
                    Untaxed Amount:        ₹<subtotal>          │ GSTIN/UIN: <company GSTIN>
                    SGST/UTGST:            ₹<half tax>          │ Voucher Type: Sales
                    CGST:                  ₹<half tax>          │ Terms of Payment: <e.g. "30 Days">
                    (or IGST:              ₹<full tax>)         │
                    Rounding:              -₹<rounding>         │ ┌─ TOTAL VALUE ──────┐
                                                                  │ │   ₹<final total>    │
                    TOTAL:                 ₹<rounded total>      │ └─────────────────────┘
                    AMOUNT DUE:            ₹<amount due>
```

- Tax column per line item shows the item's tax **percentage** (e.g. `18%`), not an amount.
- Amount column per line item is `qty × rate` (pre-tax).
- Currency symbol is ₹ throughout; use Indian digit grouping (e.g. `₹23,471.38`, not `₹23471.38`).
- "AMOUNT DUE" = Total minus any payments already recorded against the document (for invoices only — quotations/proposals don't have this line).

## Example request → response

User: "Generate a PDF for invoice #53"
1. `verify_record(module: "invoice", id_or_name: "53")` → confirm it exists and is complete.
2. Read the resolved document's fields.
3. Determine CGST+SGST vs IGST per the rule above.
4. Use the `pdf` (or `docx`) Skill to lay out the document exactly as shown above, with the real numbers.
5. Return the file to the user.
