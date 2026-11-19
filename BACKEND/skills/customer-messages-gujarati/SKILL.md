---
name: customer-messages-gujarati
description: Ready-made Gujarati and Hindi message templates for common customer communications (payment reminders, quotation follow-ups, thank-you notes). Use when the user asks to draft, write, or send a customer message in Gujarati or Hindi.
---

# Customer Message Templates (Gujarati/Hindi)

> **TODO for the team:** these are starting drafts in a professional,
> respectful tone. Review the wording against your own brand voice before
> using them for real customer communication, and add more templates here
> as you find messages you send often.

## Style rules (same as the main assistant's language rules — repeat them here so this Skill is self-contained)

- Always the respectful register: તમે (Gujarati) / आप (Hindi), never તું/तू or તમારો-informal.
- Keep business words in English inside the sentence: invoice, quotation, GST, payment, follow-up, status — don't translate these.
- Fill in the actual customer name, amount, and date from the CRM record — never leave a placeholder like `<name>` in the final message sent to a customer.

## Template: Payment reminder (Gujarati)

```
પ્રિય [ગ્રાહકનું નામ],

તમારું invoice #[invoice number] ની ₹[amount] ની payment હજુ બાકી છે, જેની due date [due date] હતી.

કૃપા કરીને શક્ય એટલી જલ્દી payment કરવા વિનંતી. જો payment પહેલેથી કરી દીધી હોય, તો આ message ને અવગણશો.

કોઈ સવાલ હોય તો અમારો સંપર્ક કરવા સંકોચ ના કરશો.

આભાર,
[કંપની નું નામ]
```

## Template: Quotation follow-up (Gujarati)

```
પ્રિય [ગ્રાહકનું નામ],

અમે તમને [date] ના રોજ મોકલેલ quotation #[quotation number] વિશે follow-up કરવા માંગીએ છીએ.

શું તમે એ જોયું? જો કોઈ સવાલ હોય અથવા વધુ માહિતી જોઈતી હોય, તો અમને જણાવો — અમે મદદ કરવા તૈયાર છીએ.

આભાર,
[કંપની નું નામ]
```

## Template: Thank-you / order confirmation (Gujarati)

```
પ્રિય [ગ્રાહકનું નામ],

તમારા order/invoice #[number] માટે આભાર. અમે તમારી સાથે કામ કરવા આતુર છીએ.

કોઈ પણ સવાલ હોય તો સંપર્ક કરવા સંકોચ ના કરશો.

આભાર,
[કંપની નું નામ]
```

## Template: Payment reminder (Hindi, for reference — same structure)

```
प्रिय [ग्राहक का नाम],

आपके invoice #[invoice number] की ₹[amount] की payment अभी भी pending है, जिसकी due date [due date] थी।

कृपया जल्द से जल्द payment करने का कष्ट करें। अगर payment पहले ही कर दी है, तो इस message को नज़रअंदाज़ करें।

कोई सवाल हो तो संपर्क करने में संकोच न करें।

धन्यवाद,
[कंपनी का नाम]
```

## How to use these

1. Pull the real customer name, amount, invoice/quotation number, and date from the CRM record first (`search_records`/`verify_record`).
2. Fill the template with the real values — never send a template with `[placeholder]` text still in it.
3. If the user asks for a tone that's more casual, more formal, or in a different language than shown here, adapt — these templates are a starting point, not a rigid script.
