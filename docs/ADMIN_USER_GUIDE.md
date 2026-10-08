# Ganabhawan Ticketing — Admin & Gate Staff Guide

This guide explains how to run the ticketing system day to day: signing in, the admin dashboard, staff accounts, gate scanning and what to do when something goes wrong. It describes the system exactly as it works today.

---

## 1. Signing in

There are two sign-in pages. Use the one that matches your job.

| Page | Who uses it |
|---|---|
| **Admin Login** — `/admin/login` | Owner, Inventory, Finance and Desk staff (the organiser's office) |
| **Gate Staff Login** — `/gate/login` | Scanner and Supervisor staff (the people at the doors) |

On either page, enter:

1. **Email** — the email the owner registered for you.
2. **Password** — the password the owner gave you.
3. Press **Login**.

That is all. There is **no authenticator app and no code**.

- After Admin Login you arrive at the **Admin dashboard**.
- After Gate Staff Login you arrive at the **Gate admission** screen (the scanner).
- If you use the wrong page, the system tells you which page to use and does not sign you in. For example, a scanner at Admin Login sees "Gate staff sign in at /gate/login."
- Customers cannot sign in on either page.
- The owner signs in at Admin Login. From the dashboard the owner can also open **Check tickets** to use the gate scanner.

To sign out, use **Sign out** at the top of the page. After signing out, the dashboard and the scanner ask you to sign in again.

---

## 2. The admin dashboard

The buttons along the top depend on your role. Each section is also protected by the server: a role that cannot see a section cannot use it either.

| Section | Who can use it | What it is for |
|---|---|---|
| **Accounts** (button) | Owner, Finance | Operations status, open payment cases ("Mark resolved"), people who tried to book, payments and refunds |
| **Check tickets** (button) | Owner (and gate staff from their own login) | Opens the gate scanner |
| **Festival & theatre** | Owner, Inventory | Festival name (English and Bengali), venue, address, contact email, **Publication status** (Draft / Published / Paused / Closed), **Hold minutes** (how long a customer's tickets are kept while they pay), **Max tickets per checkout**, auditorium photo, terms |
| **Dramas** | Owner, Inventory | Create and edit performances: title (English and Bengali), troupe, **date & time (IST)**, runtime, genre, language, synopsis, poster, and **Status** (Draft / Published / Cancelled). Only the owner can cancel a performance; cancelling is final, voids its tickets and starts refunds automatically |
| **Ticket prices** | Owner, Inventory | For each ticket type (daily ticket per performance and zone, season ticket per zone): display name, **Price (₹)** and **On sale** on/off |
| **Inventory** | Owner, Inventory | Seats per performance and zone: total capacity, season allocation, daily tickets sold online, season tickets sold online; set the season allocation for a zone across all upcoming performances; create a season ticket; add a performance to a season ticket |
| **Auditorium zones** | Owner, Inventory | Reference picture of the hall (Premier, Superior, Balcony) as customers see it |
| **Staff** | Owner only | Create staff, reset passwords, deactivate staff (section 3) |
| **Metrics** | Owner, Inventory, Finance | Tickets sold, revenue, daily vs season, sales by show and zone; scans, admitted, rejected, duplicates, by show, gate and scanner; payments and refunds. Filter by show, zone, scanner, payment status and dates |

**Desk** accounts currently have no dashboard sections; the dashboard says so when a desk user signs in.

Important rules the system enforces:

- A new performance does **not** join an existing season ticket automatically. Add it under Inventory → "Add a performance to a season ticket". This is possible only before any season ticket of that zone is sold.
- Allocations can never be set below what is already sold or held, and daily + season allocation can never exceed a zone's capacity.

---

## 3. Staff management (owner only)

Open **Staff** in the dashboard.

### Create a staff member

Under **Add staff**, fill in:

| Field | What to enter |
|---|---|
| **Email** | The person's own email. They sign in with it. |
| **Name** | Their name (shown in the staff list and in scan reports). |
| **Role** | Scanner (gate), Supervisor (gate), Inventory (shows, prices, stock), Finance (accounts, metrics) or Desk. |
| **Initial password** | At least 12 characters. Give it to the person privately. |

Press **Save staff**. The new person appears in the list with their status, for example:
"Active · Password set · can scan 12 upcoming shows · signs in at /gate/login".

Tell the person three things: their email, their password, and their sign-in page (Gate Staff Login for scanners and supervisors, Admin Login for the others).

Owner accounts cannot be created from the dashboard; they are set up by the system administrator.

### Reset a password

On the person's card press **Reset password**, type the new password (at least 12 characters) and confirm. The person is signed out on every device and must use the new password.

### Deactivate a staff member

On the person's card press **Deactivate** and type a short reason (it is recorded). The person can no longer sign in, loses gate access immediately, and disappears from the staff list.

### Reactivate

To bring someone back, add them again under **Add staff** with the same email, the role you want and a new password.

---

## 4. Setting up a gate scanner

1. **Create the scanner**: Staff → Add staff → Role **Scanner (gate)** → Save staff.
2. **Permissions are automatic**: a scanner can scan **every upcoming performance** (published or draft, not cancelled, not yet ended) at **both gates** (Main entrance and Balcony entrance). Performances added later are added automatically. There is nothing to tick.
3. **Gates**: the system has two gates, **Main entrance** and **Balcony entrance**. They are fixed; there is no screen to add or remove gates.
4. **Show**: chosen by the scanner on the gate screen (step 7).
5. **Device**: the phone or tablet used at the door. The gate chosen on the screen is the device; it is remembered on that phone.
6. **Sign in**: on the door phone open `/gate/login` and sign in with the scanner's email and password.
7. **Gate admission screen**: choose **Gate** (Main entrance or Balcony entrance) and **Performance** (today's show).
8. **Start scanning**: press **Open camera** and point it at the customer's ticket QR code.

Tip: on the door phone, open the browser menu and choose **Add to Home Screen** so the scanner opens like an app.

**Samatat mobile app (if your organiser installed it):** on its sign-in screen tap **"Gate staff? Sign in with email and password"**, sign in with the same email and password, then open the **Door** tab, pick the performance and point the camera at the ticket. The app always scans as **Main entrance**; use the browser scanner above if you work at the Balcony entrance.

---

## 5. Setting up a supervisor

1. Staff → Add staff → Role **Supervisor (gate)** → Save staff. A supervisor gets the same automatic permissions as a scanner.
2. The supervisor signs in at `/gate/login`.
3. The supervisor uses the same Gate admission screen and can scan tickets like a scanner.
4. Supervising is an operational job: the system gives supervisors the same scanning screen, not extra controls. A supervisor helps scanners, handles rejected or duplicate tickets at the door, and escalates to the owner.
5. Admission reports (Metrics) are seen by the owner, inventory and finance; supervisors ask the owner if they need numbers.

---

## 6. Scanning a ticket

1. Check that **Gate** and **Performance** are right.
2. Press **Open camera** and show the camera the QR code on the customer's ticket page (or printed ticket).
   If the camera does not work, type or paste the ticket code into **Ticket token** and press **Admit**.
3. The result fills the screen:

| Screen | Meaning | What to do |
|---|---|---|
| ✅ **ADMITTED** | Valid ticket, first entry for this performance | Let the person in |
| 🚫 **DENIED** — "Ticket already admitted for this show." | The ticket was already used for this performance | Do not admit; call the supervisor |
| 🚫 **DENIED** — "No active entitlement for this show." | Valid ticket, but for a different performance | Do not admit; check the date and show on their ticket |
| 🚫 **DENIED** — "This performance is not open for entry." | The performance is cancelled or not published | Do not admit; call the supervisor |
| 🚫 **DENIED** — "Entry is outside the allowed time window." | Too early or too late: by default doors open 60 minutes before the start and close 15 minutes after it (set by the system administrator; not on the dashboard) | Ask them to wait, or call the supervisor |
| 🚫 **DENIED** — "Staff not authorized for this show, gate, or device." | Your account cannot scan this performance at this gate | Check the Performance and Gate you chose; call the supervisor |
| ⚠️ **UNKNOWN** — "Credential not found or inactive." | Not a valid ticket (fake, mistyped or cancelled QR) | Do not admit; call the supervisor |
| ⚠️ "Network error — result unknown. Do not admit." | The phone lost connection | Do not admit; try again when connected |

4. Press **Next guest** to scan the next ticket.

Notes:

- Tickets are not tied to a particular gate: a valid ticket is admitted at either gate.
- A season ticket has a separate entry for each performance it covers, so it can be used once per performance.
- Two scanners scanning the same ticket at the same moment cannot both admit it. Only one entry is accepted.

---

## 7. Gate operations

- **Choosing the gate**: pick Main entrance or Balcony entrance on the gate screen. The phone remembers it.
- **Choosing the show**: the Performance list shows published performances that have not ended. Pick the one at the door now.
- **Before doors open (scanner)**: sign in, choose gate and performance, open the camera, and scan one known-good ticket if you have one.
- **During the show (supervisor)**: watch for repeated DENIED or UNKNOWN results, help scanners with problem tickets, and keep the queue moving.

---

## 8. Staff passwords

- The owner sets every staff password when creating the account, and can reset it at any time (section 3). Passwords must be at least 12 characters.
- Staff cannot change or recover their own password; they ask the owner.
- The system never shows a password after it is saved.

---

## 9. When a staff member leaves

Staff → find the person → **Deactivate** → type the reason. Do this on their last day. Temporary event staff should be deactivated after the event.

---

## 10. Daily operating procedure

**Before the event**
- Dashboard → Staff: check every scanner and supervisor working today is listed as Active.
- Dashboard → Dramas: check today's performance is **Published** and the date and time are right.
- Each door phone: sign in at `/gate/login`, choose the correct **Gate** and **Performance**.
- Test the camera on each phone; scan one valid ticket if you have one.

**During the event**
- Scanners scan every ticket and follow the result screen.
- Supervisors handle every DENIED and UNKNOWN case at the door.
- Problems with the system (it will not load, everyone gets network errors) go to the owner.

**After the event**
- Close the scanner screens and sign out on the door phones.
- Dashboard → Metrics: review admissions (admitted, rejected, duplicates, by gate and scanner).
- Deactivate any temporary staff.

---

## 11. Troubleshooting

| Problem | What to do |
|---|---|
| **Cannot log in** ("Incorrect email or password") | Check the email and password. Ask the owner to reset the password. |
| **"Gate staff sign in at /gate/login"** | You are a scanner or supervisor: use Gate Staff Login. |
| **"Admin staff sign in at /admin/login"** | You are owner/office staff: use Admin Login. |
| **"This account cannot scan tickets"** on the gate screen | You signed in with an office account. Sign out and sign in at Gate Staff Login with a scanner or supervisor account. |
| **Scanner cannot use a gate or show** ("Staff not authorized…") | Check the chosen Gate and Performance. If it continues, the owner checks the account is Active (and, if needed, deactivates and re-adds it). |
| **QR rejected** | Follow the table in section 6. Never admit on DENIED or UNKNOWN. |
| **Ticket already used** | Do not admit. Supervisor checks with the customer. |
| **Wrong show** | Check the ticket's performance and date. |
| **Camera not working** | Allow camera access in the browser, or type the ticket code into **Ticket token** and press **Admit**. |
| **Staff account deactivated** | The person cannot sign in until the owner adds them again. |
| **Anything else, or the system is down** | Contact the owner/admin. |

---

## 12. Security guidelines

- Never share your password, and never write it where others can see it.
- One person, one account. Do not share staff accounts; every scan is recorded against the account used.
- Deactivate staff as soon as they leave or the event ends.
- Scanner and supervisor accounts cannot open the admin dashboard, and the system enforces this.
- A supervisor is not an owner: only the owner manages staff.
- Always use the correct sign-in page: Admin Login for the office, Gate Staff Login for the doors.
