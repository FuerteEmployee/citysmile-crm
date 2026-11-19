# CRM Backend - Technical API Documentation (v1.0)

This document provides granular details for every module in the CRM backend.

---

## 1. Authentication & Security

### Staff Authentication
*   **Base URL**: `/api/auth`
*   **Login**: `POST /login`
    *   **Payload**: `{ "email": "string", "password": "string" }`
    *   **Security**: Returns JWT in response if 2FA is disabled. If 2FA is enabled, returns `two_factor_auth_enabled: true`.
*   **Verify 2FA**: `POST /verify-2fa`
    *   **Payload**: `{ "email": "string", "code": "string" }`
    *   **Logic**: Code expires after 10 minutes.

### Role-Based Access Control (RBAC)
*   **Permissions Matrix**: Every staff member has a `role`. Permissions are: `view`, `view_own`, `create`, `edit`, `delete`.
*   **Overrides**: Staff can have specific permission overrides in their `permissions` Map field.

---

## 2. Staff Management
*   **Model (`Staff`)**:
    *   `firstname` (String, Required)
    *   `lastname` (String, Required)
    *   `email` (String, Required, Unique)
    *   `password` (String, Required)
    *   `phonenumber` (String)
    *   `admin` (Boolean, Default: false)
    *   `role` (ObjectId, Ref: Role)
    *   `active` (Boolean, Default: true)
    *   `two_factor_auth_enabled` (Number: 0=Disabled, 1=Email, 2=App)
*   **Endpoints**:
    *   `GET /api/staff` - Requires `staff.view`
    *   `POST /api/staff` - Requires `staff.create`
    *   `PUT /api/staff/:id` - Requires `staff.edit`
    *   `DELETE /api/staff/:id` - Requires `staff.delete`

---

## 3. Customer Management (Clients & Contacts)

### Clients
*   **Model (`Client`)**:
    *   `company` (String, Required)
    *   `vat` (String)
    *   `phonenumber` (String)
    *   `website` (String)
    *   `billing_street/city/state/zip/country` (Strings)
    *   `shipping_street/city/state/zip/country` (Strings)
    *   `groups` (Array of ObjectIds, Ref: ClientGroup)
*   **Endpoints**:
    *   `GET /api/clients` - Populates `groups`
    *   `POST /api/clients` - Includes `custom_fields` object.
    *   `PUT /api/clients/:id`

### Contacts
*   **Model (`Contact`)**:
    *   `userid` (ObjectId, Ref: Client, Required)
    *   `is_primary` (Boolean)
    *   `firstname/lastname/email` (Required)
    *   `invoice_emails/ticket_emails/etc` (Boolean notification preferences)
*   **Endpoints**:
    *   `GET /api/clients/:clientId/contacts`
    *   `POST /api/clients/:clientId/contacts`

### Client Vault
*   **Model (`VaultEntry`)**:
    *   `client` (ObjectId, Required)
    *   `server` (String)
    *   `port` (String)
    *   `username` (String)
    *   `password` (String, Required)
    *   `description` (String)
    *   `visibility` (String, "all"|"staff")
*   **Endpoints**:
    *   `GET /api/clients/:clientId/vault`
    *   `POST /api/clients/:clientId/vault`
    *   **Payload Example**:
    ```json
    { "server": "1.1.1.1", "port": "22", "username": "admin", "password": "...", "visibility": "staff" }
    ```

---

## 4. Sales Pipeline (Leads)
*   **Model (`Lead`)**:
    *   `name` (Required), `title`, `company`, `email`, `phonenumber`
    *   `status` (ObjectId, Ref: LeadStatus)
    *   `source` (ObjectId, Ref: LeadSource)
    *   `assigned` (ObjectId, Ref: Staff)
    *   `junk/lost` (Boolean)
*   **Endpoints**:
    *   `GET /api/leads` - Populates status and source.
    *   `POST /api/leads` - Automatically sets `addedfrom`.

---

## 5. Projects & Tasks

### Projects
*   **Model (`Project`)**:
    *   `name` (Required), `description`
    *   `status` (Number: 1=Not Started, 2=Progress, 3=Hold, 4=Finished, 5=Cancelled)
    *   `clientid` (ObjectId, Required)
    *   `billing_type` (1=Fixed, 2=Project Hours, 3=Task Hours)
    *   `start_date`, `deadline`
    *   `progress` (Percent)
*   **Endpoints**:
    *   `GET /api/projects`
    *   `POST /api/projects`

### Tasks
*   **Model (`Task`)**:
    *   `name` (Required), `priority` (1-4), `status` (1-5)
    *   `rel_id` (ObjectId), `rel_type` (e.g., 'project', 'invoice')
    *   `billable` (Boolean), `hourly_rate` (Number)
    *   `visible_to_client` (Boolean)
*   **Endpoints**:
    *   `GET /api/tasks`
    *   `POST /api/tasks`

---

## 6. Financials (Invoices, Estimates, Payments)

### Invoices
*   **Model (`Invoice`)**:
    *   `number` (Unique String, e.g., INV-0001)
    *   `client` (ObjectId, Required)
    *   `items` (Array of objects: `description`, `qty`, `rate`, `tax`)
    *   `status` (unpaid, paid, partially_paid, overdue, cancelled)
    *   `subtotal`, `total`, `discount_percent`, `adjustment`
*   **Logic**: `InvoiceService` calculates totals during POST/PUT.

### Payments
*   **Model (`Payment`)**:
    *   `invoice` (ObjectId, Required), `amount`, `paymentmode`, `transactionid`
*   **Automated Action**: Recording a payment updates the `Invoice.status`.

---

## 7. Support System (Tickets & Knowledge Base)

### Tickets
*   **Model (`Ticket`)**:
    *   `subject` (String, Required), `message` (String, Required)
    *   `client` (ObjectId, Ref: Client), `contact` (ObjectId, Ref: Contact)
    *   `department` (ObjectId, Ref: Department, Required)
    *   `priority` (ObjectId, Ref: Priority), `status` (String, Default: "open")
    *   `assigned` (ObjectId, Ref: Staff), `service` (String, Optional)
*   **Endpoints**:
    *   `GET /api/tickets` - List with population.
    *   `POST /api/tickets` - Create with custom fields.
    *   **Payload Example**:
    ```json
    { "subject": "Urgent Help", "message": "My site is down", "department": "...", "priority": "..." }
    ```

### Knowledge Base
*   **Model (`KBGroup`)**: `name`, `description`, `group_order`, `active`
*   **Model (`KBArticle`)**: `subject`, `description` (HTML Content), `group` (Ref: KBGroup), `article_order`, `active`, `staff_article` (Boolean)
*   **Endpoints**:
    *   `GET /api/knowledge-base/groups`: List KB categories.
    *   `GET /api/knowledge-base/articles`: List KB articles (Filter by `group` query param).

---

## 8. Utilities & Collaboration

### Announcements
*   **Model (`Announcement`)**: `name`, `message`, `showtousers`, `showtostaff`, `showname`
*   **Endpoints**: `GET /api/announcements`, `POST /api/announcements`

### Internal Tasks (Todo)
*   **Model (`Todo`)**: `description`, `staff` (Ref: Staff), `finished` (Boolean), `datefinished`
*   **Endpoints**: `GET /api/todos`, `POST /api/todos`, `PUT /api/todos/:id`

### Expenses & Subscriptions
*   **Model (`Expense`)**: `category`, `amount`, `tax`, `reference_no`, `note`, `client`, `project`, `billable`, `paymentmode`, `date`
*   **Model (`Subscription`)**: `name`, `client`, `amount`, `currency`, `interval` ("month"|"year"), `interval_count`, `status`
*   **Endpoints**: `GET /api/expenses`, `POST /api/expenses`, `GET /api/subscriptions`, `POST /api/subscriptions`

---

## 9. Full Route Table
| Module | Base Path | Key Sub-Paths |
| :--- | :--- | :--- |
| Auth | `/api/auth` | `/login`, `/verify-2fa`, `/me` |
| Clients | `/api/clients` | `/:id`, `/:id/contacts`, `/:id/vault` |
| Leads | `/api/leads` | `/pipeline/statuses`, `/pipeline/sources` |
| Sales | `/api/invoices` | `/estimates`, `/proposals`, `/credit-notes` |
| Projects | `/api/projects` | `/milestones`, `/tasks` |
| Utils | `/api/settings` | `/activity-logs`, `/reports/financial` |
| Collab | `/api/announcements` | `/todos` |
| Billing | `/api/expenses` | `/subscriptions` |
| Catalog | `/api/items` | `/taxes` |
