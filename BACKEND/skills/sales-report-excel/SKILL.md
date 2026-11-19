---
name: sales-report-excel
description: Generates an Excel sales/revenue report with charts from Fuerte CRM data (invoices, payments, expenses). Use when the user asks for a report, export, or summary as a spreadsheet, or asks to "download" or "email" a sales/revenue report.
---

# Sales Report Excel Generation

This Skill supplies the report structure and formatting conventions. Pair
it with Anthropic's pre-built `xlsx` Skill to actually produce the file.

## Where the source data comes from

Never invent figures. Pull real numbers using the CRM's own tools:
- `get_analytics` for revenue, expenses, outstanding invoices, and record counts over a period.
- `search_records` (module: `invoice`, `payment`, `expense`, `client`) for the underlying line-level detail behind a summary number.

If the user names a period ("last month", "this quarter", "2026 so far"), resolve it to an actual date range using today's date before querying — don't hand-wave the range.

## Report structure

Build two sheets, not one:

**Sheet 1 — "Summary"**
- Header block: report title, date range covered, generated date.
- KPI row: Total Revenue, Total Expenses, Net, Outstanding (unpaid invoices), Invoice Count — each as its own cell, bold, with ₹ formatting.
- One bar chart: revenue by month (or by week, if the range is under 2 months) across the period.
- One pie chart: invoice status breakdown (Paid / Unpaid / Partially Paid / Overdue / Draft).

**Sheet 2 — "Detail"**
- One row per invoice (or per payment/expense, depending on what was asked for), columns: Number, Client, Date, Status, Subtotal, Tax, Total, Amount Paid, Amount Due.
- Freeze the header row. Auto-filter enabled on the header.

## Formatting conventions (match the CRM's own style)

- Currency: ₹ symbol, Indian digit grouping (₹4,50,000, not ₹450,000 or ₹450000).
- Dates: DD-MM-YYYY, matching how dates already display elsewhere in this CRM.
- Status cells: color-code lightly if the xlsx Skill supports cell fill — green for Paid/Accepted, amber for Pending/Partial, red for Overdue.
- Sheet and file name: `<ReportType>_<StartDate>_to_<EndDate>.xlsx`, e.g. `SalesReport_2026-08-01_to_2026-08-31.xlsx`.

## Example request → response

User: "Give me an Excel report of this month's sales"
1. Resolve "this month" to the actual date range using today's date.
2. `get_analytics` for revenue/expenses/outstanding over that range.
3. `search_records(module: "invoice", ...)` for the detail rows.
4. Use the `xlsx` Skill to build the two-sheet workbook per the structure above.
5. Return the file to the user.
