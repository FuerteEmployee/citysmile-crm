// One-off seed: populates the default set of transactional email templates
// shown on Setup > Email Templates, grouped by module. Safe to re-run — it
// only inserts templates that don't already exist (matched by name+module).
const mongoose = require("mongoose");
require("dotenv").config();
const EmailTemplate = require("../models/EmailTemplate");

const generic = (subject, message) => ({ subject, message });

const TEMPLATES = [
  // ── Tickets ────────────────────────────────────────────────────────────
  ["Tickets", "New Ticket Opened (Opened by Staff, Sent to Customer)", "A new ticket has been opened for you: {ticket_subject}", "Hello {contact_name},\n\nA new support ticket has been opened on your behalf.\n\nSubject: {ticket_subject}\nTicket ID: {ticket_id}\n\nOur team will respond as soon as possible.\n\n{email_signature}"],
  ["Tickets", "Ticket Reply (Sent to Customer)", "Re: {ticket_subject}", "Hello {contact_name},\n\nThere is a new reply on your ticket \"{ticket_subject}\".\n\n{ticket_reply_message}\n\n{email_signature}"],
  ["Tickets", "New Ticket Opened - Autoresponse", "We received your ticket: {ticket_subject}", "Hello {contact_name},\n\nThank you for contacting support. We have received your ticket and will respond shortly.\n\nSubject: {ticket_subject}\n\n{email_signature}"],
  ["Tickets", "New Ticket Created (Opened by Customer, Sent to Staff Members)", "New ticket: {ticket_subject}", "A new ticket was opened by {contact_name}.\n\nSubject: {ticket_subject}\nDepartment: {ticket_department}\n\nView it in the CRM to respond."],
  ["Tickets", "Ticket Reply (Sent to Staff)", "Re: {ticket_subject}", "{contact_name} replied to ticket \"{ticket_subject}\".\n\n{ticket_reply_message}"],
  ["Tickets", "Auto Close Ticket", "Your ticket has been closed: {ticket_subject}", "Hello {contact_name},\n\nYour ticket \"{ticket_subject}\" has been automatically closed due to inactivity. Reply to reopen it if needed.\n\n{email_signature}"],
  ["Tickets", "New Ticket Assigned (Sent to Staff)", "Ticket assigned to you: {ticket_subject}", "Hello {staff_name},\n\nTicket \"{ticket_subject}\" has been assigned to you.\n\nPlease review and respond."],

  // ── Estimates ──────────────────────────────────────────────────────────
  ["Estimates", "Send Estimate to Customer", "Estimate {estimate_number} from {company_name}", "Hello {contact_name},\n\nPlease find attached estimate {estimate_number}.\n\nTotal: {estimate_total}\nValid until: {estimate_expirydate}\n\n{email_signature}"],
  ["Estimates", "Estimate Already Sent to Customer", "Estimate {estimate_number} - Reminder", "Hello {contact_name},\n\nThis is a reminder regarding estimate {estimate_number} sent to you previously.\n\n{email_signature}"],
  ["Estimates", "Estimate Declined (Sent to Staff)", "Estimate {estimate_number} declined", "{contact_name} has declined estimate {estimate_number}."],
  ["Estimates", "Estimate Accepted (Sent to Staff)", "Estimate {estimate_number} accepted", "{contact_name} has accepted estimate {estimate_number}."],
  ["Estimates", "Thank You Email (Sent to Customer After Accept)", "Thank you for accepting estimate {estimate_number}", "Hello {contact_name},\n\nThank you for accepting estimate {estimate_number}. We will be in touch shortly with next steps.\n\n{email_signature}"],
  ["Estimates", "Estimate Expiration Reminder", "Estimate {estimate_number} is expiring soon", "Hello {contact_name},\n\nEstimate {estimate_number} will expire on {estimate_expirydate}. Please respond before then.\n\n{email_signature}"],

  // ── Contracts ──────────────────────────────────────────────────────────
  ["Contracts", "Contract Expiration Reminder (Sent to Customer Contacts)", "Your contract is expiring soon", "Hello {contact_name},\n\nYour contract \"{contract_subject}\" is set to expire on {contract_enddate}.\n\n{email_signature}"],
  ["Contracts", "Send Contract to Customer", "Contract for your review: {contract_subject}", "Hello {contact_name},\n\nPlease review and sign the attached contract \"{contract_subject}\".\n\n{email_signature}"],
  ["Contracts", "New Comment  (Sent to Customer Contacts)", "New comment on contract {contract_subject}", "Hello {contact_name},\n\nA new comment was added to contract \"{contract_subject}\".\n\n{comment_content}"],
  ["Contracts", "New Comment (Sent to Staff)", "New comment on contract {contract_subject}", "{contact_name} commented on contract \"{contract_subject}\".\n\n{comment_content}"],
  ["Contracts", "Contract Expiration Reminder (Sent to Staff)", "Contract expiring soon: {contract_subject}", "Contract \"{contract_subject}\" for {client_company} expires on {contract_enddate}."],
  ["Contracts", "Contract Signed (Sent to Staff)", "Contract signed: {contract_subject}", "{contact_name} has signed contract \"{contract_subject}\"."],
  ["Contracts", "Contract Sign Reminder (Sent to Customer)", "Please sign your contract: {contract_subject}", "Hello {contact_name},\n\nThis is a reminder to sign contract \"{contract_subject}\".\n\n{email_signature}"],

  // ── Invoices ───────────────────────────────────────────────────────────
  ["Invoices", "Send Invoice to Customer", "Invoice {invoice_number} from {company_name}", "Hello {contact_name},\n\nPlease find attached invoice {invoice_number}.\n\nTotal due: {invoice_total}\nDue date: {invoice_duedate}\n\n{email_signature}"],
  ["Invoices", "Invoice Payment Recorded (Sent to Customer)", "Payment received for invoice {invoice_number}", "Hello {contact_name},\n\nWe've recorded your payment of {payment_amount} for invoice {invoice_number}. Thank you!\n\n{email_signature}"],
  ["Invoices", "Invoice Overdue Notice", "Invoice {invoice_number} is overdue", "Hello {contact_name},\n\nInvoice {invoice_number} was due on {invoice_duedate} and is now overdue. Please arrange payment as soon as possible.\n\n{email_signature}"],
  ["Invoices", "Invoice Already Sent to Customer", "Invoice {invoice_number} - Reminder", "Hello {contact_name},\n\nThis is a reminder regarding invoice {invoice_number}.\n\n{email_signature}"],
  ["Invoices", "Invoice Payment Recorded (Sent to Staff)", "Payment recorded for invoice {invoice_number}", "A payment of {payment_amount} was recorded for invoice {invoice_number} ({client_company})."],
  ["Invoices", "Invoice Due Notice", "Invoice {invoice_number} due on {invoice_duedate}", "Hello {contact_name},\n\nThis is a reminder that invoice {invoice_number} is due on {invoice_duedate}.\n\n{email_signature}"],
  ["Invoices", "Invoices Payments Recorded in Batch (Sent to Customer)", "Payments recorded", "Hello {contact_name},\n\nWe've recorded payments across multiple invoices on your account. See your account statement for details.\n\n{email_signature}"],

  // ── Subscriptions ──────────────────────────────────────────────────────
  ["Subscriptions", "Send Subscription to Customer", "Your subscription: {subscription_name}", "Hello {contact_name},\n\nYour subscription \"{subscription_name}\" is ready. {subscription_url}\n\n{email_signature}"],
  ["Subscriptions", "Subscription Payment Failed", "Payment failed for your subscription", "Hello {contact_name},\n\nWe were unable to process payment for subscription \"{subscription_name}\". Please update your payment method.\n\n{email_signature}"],
  ["Subscriptions", "Subscription Canceled (Sent to customer primary contact)", "Your subscription has been canceled", "Hello {contact_name},\n\nYour subscription \"{subscription_name}\" has been canceled.\n\n{email_signature}"],
  ["Subscriptions", "Subscription Payment Succeeded (Sent to customer primary contact)", "Payment successful for your subscription", "Hello {contact_name},\n\nYour payment for subscription \"{subscription_name}\" was successful. Thank you!\n\n{email_signature}"],
  ["Subscriptions", "Customer Subscribed to a Subscription (Sent to administrators and subscription creator)", "New subscription: {subscription_name}", "{contact_name} has subscribed to \"{subscription_name}\"."],
  ["Subscriptions", "Credit Card Authorization Required - SCA", "Action required: authorize your payment", "Hello {contact_name},\n\nYour bank requires additional authorization (SCA) to process payment for subscription \"{subscription_name}\". Please complete this at: {subscription_url}\n\n{email_signature}"],

  // ── Credit Note ────────────────────────────────────────────────────────
  ["Credit Note", "Send Credit Note To Email", "Credit Note {credit_note_number}", "Hello {contact_name},\n\nPlease find attached credit note {credit_note_number} for {credit_note_total}.\n\n{email_signature}"],

  // ── Tasks ──────────────────────────────────────────────────────────────
  ["Tasks", "New Task Assigned (Sent to Staff)", "Task assigned to you: {task_name}", "Hello {staff_name},\n\nYou've been assigned to task \"{task_name}\", due {task_duedate}."],
  ["Tasks", "Staff Member Added as Follower on Task (Sent to Staff)", "You're now following task: {task_name}", "Hello {staff_name},\n\nYou've been added as a follower on task \"{task_name}\"."],
  ["Tasks", "New Comment on Task (Sent to Staff)", "New comment on task: {task_name}", "{staff_name} commented on task \"{task_name}\".\n\n{comment_content}"],
  ["Tasks", "New Attachment(s) on Task (Sent to Staff)", "New attachment on task: {task_name}", "A new file was uploaded to task \"{task_name}\"."],
  ["Tasks", "Task Deadline Reminder - Sent to Assigned Members", "Task due soon: {task_name}", "Hello {staff_name},\n\nTask \"{task_name}\" is due on {task_duedate}."],
  ["Tasks", "New Attachment(s) on Task (Sent to Customer Contacts)", "New attachment on task: {task_name}", "Hello {contact_name},\n\nA new file was uploaded to task \"{task_name}\"."],
  ["Tasks", "New Comment on Task (Sent to Customer Contacts)", "New comment on task: {task_name}", "Hello {contact_name},\n\nA new comment was added to task \"{task_name}\".\n\n{comment_content}"],
  ["Tasks", "Task Status Changed (Sent to Staff)", "Task status updated: {task_name}", "Task \"{task_name}\" status changed to {task_status}."],
  ["Tasks", "Task Status Changed (Sent to Customer Contacts)", "Task status updated: {task_name}", "Hello {contact_name},\n\nThe status of task \"{task_name}\" changed to {task_status}."],

  // ── Customers ──────────────────────────────────────────────────────────
  ["Customers", "New Contact Added/Registered (Welcome Email)", "Welcome to {company_name}", "Hello {contact_name},\n\nWelcome! Your account has been created. You can log in at {client_area_url}.\n\n{email_signature}"],
  ["Customers", "Forgot Password", "Reset your password", "Hello {contact_name},\n\nClick the link below to reset your password:\n{reset_password_url}\n\nIf you didn't request this, ignore this email."],
  ["Customers", "Password Reset - Confirmation", "Your password has been reset", "Hello {contact_name},\n\nYour password was successfully reset. If this wasn't you, contact us immediately.\n\n{email_signature}"],
  ["Customers", "Set New Password", "Set your password", "Hello {contact_name},\n\nPlease set your password using the link below:\n{set_password_url}"],
  ["Customers", "Statement - Account Summary", "Your account statement", "Hello {contact_name},\n\nPlease find attached your account statement.\n\n{email_signature}"],
  ["Customers", "New Customer Registration (Sent to admins)", "New customer registered: {client_company}", "A new customer \"{client_company}\" has registered."],
  ["Customers", "Email Verification (Sent to Contact After Registration)", "Verify your email address", "Hello {contact_name},\n\nPlease verify your email address by clicking the link below:\n{email_verification_url}"],
  ["Customers", "New Customer Profile File(s) Uploaded (Sent to Staff)", "New file uploaded by {client_company}", "{contact_name} from {client_company} uploaded a new file to their profile."],

  // ── Proposals ──────────────────────────────────────────────────────────
  ["Proposals", "Customer Action - Accepted (Sent to Staff)", "Proposal accepted: {proposal_subject}", "{contact_name} has accepted proposal \"{proposal_subject}\"."],
  ["Proposals", "Send Proposal to Customer", "Proposal: {proposal_subject}", "Hello {contact_name},\n\nPlease find attached our proposal \"{proposal_subject}\".\n\n{email_signature}"],
  ["Proposals", "Customer Action - Declined (Sent to Staff)", "Proposal declined: {proposal_subject}", "{contact_name} has declined proposal \"{proposal_subject}\"."],
  ["Proposals", "Thank You Email (Sent to Customer After Accept)", "Thank you for accepting our proposal", "Hello {contact_name},\n\nThank you for accepting \"{proposal_subject}\". We'll be in touch with next steps.\n\n{email_signature}"],
  ["Proposals", "New Comment  (Sent to Customer/Lead)", "New comment on proposal {proposal_subject}", "Hello {contact_name},\n\nA new comment was added to proposal \"{proposal_subject}\".\n\n{comment_content}"],
  ["Proposals", "New Comment (Sent to Staff)", "New comment on proposal {proposal_subject}", "{contact_name} commented on proposal \"{proposal_subject}\".\n\n{comment_content}"],
  ["Proposals", "Proposal Expiration Reminder", "Proposal {proposal_subject} is expiring soon", "Hello {contact_name},\n\nProposal \"{proposal_subject}\" expires on {proposal_open_till}. Please respond soon.\n\n{email_signature}"],

  // ── Projects ───────────────────────────────────────────────────────────
  ["Projects", "New Project Discussion (Sent to Project Members)", "New discussion in project: {project_name}", "A new discussion \"{discussion_subject}\" was started in project \"{project_name}\"."],
  ["Projects", "New Project Discussion (Sent to Customer Contacts)", "New discussion in project: {project_name}", "Hello {contact_name},\n\nA new discussion \"{discussion_subject}\" was started in project \"{project_name}\"."],
  ["Projects", "New Project File(s) Uploaded (Sent to Customer Contacts)", "New file uploaded to project: {project_name}", "Hello {contact_name},\n\nA new file was uploaded to project \"{project_name}\"."],
  ["Projects", "New Project File(s) Uploaded (Sent to Project Members)", "New file uploaded to project: {project_name}", "A new file was uploaded to project \"{project_name}\"."],
  ["Projects", "New Discussion Comment (Sent to Customer Contacts)", "New comment on discussion: {discussion_subject}", "Hello {contact_name},\n\nA new comment was added to discussion \"{discussion_subject}\".\n\n{comment_content}"],
  ["Projects", "New Discussion Comment (Sent to Project Members)", "New comment on discussion: {discussion_subject}", "A new comment was added to discussion \"{discussion_subject}\".\n\n{comment_content}"],
  ["Projects", "Staff Added as Project Member", "You've been added to project: {project_name}", "Hello {staff_name},\n\nYou've been added as a member of project \"{project_name}\"."],
  ["Projects", "New Project Created (Sent to Customer Contacts)", "New project created: {project_name}", "Hello {contact_name},\n\nA new project \"{project_name}\" has been created for you."],
  ["Projects", "Project Marked as Finished (Sent to Customer Contacts)", "Project completed: {project_name}", "Hello {contact_name},\n\nProject \"{project_name}\" has been marked as finished.\n\n{email_signature}"],

  // ── Staff Members ──────────────────────────────────────────────────────
  ["Staff Members", "New Staff Created (Welcome Email)", "Welcome to the team, {staff_name}", "Hello {staff_name},\n\nYour staff account has been created. Login at {staff_login_url}.\n\n{email_signature}"],
  ["Staff Members", "Forgot Password", "Reset your password", "Hello {staff_name},\n\nClick the link below to reset your password:\n{reset_password_url}"],
  ["Staff Members", "Password Reset - Confirmation", "Your password has been reset", "Hello {staff_name},\n\nYour password was successfully reset."],
  ["Staff Members", "Two Factor Authentication", "Your verification code", "Hello {staff_name},\n\nYour two-factor authentication code is: {otp_code}"],
  ["Staff Members", "Staff Reminder Email", "Reminder: {reminder_description}", "Hello {staff_name},\n\nThis is a reminder: {reminder_description}, due {reminder_date}."],
  ["Staff Members", "Event Notification (Calendar)", "Upcoming event: {event_name}", "Hello {staff_name},\n\nYou have an upcoming calendar event \"{event_name}\" on {event_date}."],

  // ── Leads ──────────────────────────────────────────────────────────────
  ["Leads", "New Lead Assigned to Staff Member", "Lead assigned to you: {lead_name}", "Hello {staff_name},\n\nLead \"{lead_name}\" has been assigned to you."],
  ["Leads", "Web to lead form submitted - Sent to lead", "Thank you for contacting {company_name}", "Hello {lead_name},\n\nThank you for reaching out. Our team will be in touch shortly.\n\n{email_signature}"],

  // ── Estimate Request ───────────────────────────────────────────────────
  ["Estimate Request", "Estimate Request Submitted (Sent to Staff)", "New estimate request submitted", "A new estimate request was submitted via \"{form_name}\" by {contact_name}."],
  ["Estimate Request", "Estimate Request Assigned (Sent to Staff)", "Estimate request assigned to you", "Hello {staff_name},\n\nAn estimate request from {contact_name} has been assigned to you."],
  ["Estimate Request", "Estimate Request Removed (Sent to User)", "Your estimate request was removed", "Hello {contact_name},\n\nYour estimate request submitted on {request_date} has been removed."],

  // ── Notifications ──────────────────────────────────────────────────────
  ["Notifications", "Non-billed tasks reminder (sent to selected staff members)", "Reminder: non-billed tasks", "Hello {staff_name},\n\nYou have non-billed billable tasks pending invoicing. Please review them."],

  // ── GDPR ───────────────────────────────────────────────────────────────
  ["General Data Protection Regulation (GDPR)", "Removal Request From Contact (Sent to administrators)", "Data removal request from {contact_name}", "{contact_name} has requested removal of their personal data under GDPR."],
  ["General Data Protection Regulation (GDPR)", "Removal Request From Lead (Sent to administrators)", "Data removal request from {lead_name}", "{lead_name} has requested removal of their personal data under GDPR."],
];

async function seed() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("Connected. Seeding email templates...");

  let inserted = 0;
  let skipped = 0;

  for (const [module, name, subject, message] of TEMPLATES) {
    const exists = await EmailTemplate.findOne({ module, name });
    if (exists) {
      skipped++;
      continue;
    }
    await EmailTemplate.create({ module, name, subject, message, active: true });
    inserted++;
  }

  console.log(`Done. Inserted ${inserted}, skipped ${skipped} (already existed). Total defined: ${TEMPLATES.length}`);
  await mongoose.disconnect();
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
