**DigitalBurj Restaurant & Food Service OS should connect every order to kitchen execution, ingredient consumption, payments, staff activity, and actual profitability.** The owner should be able to see what needs attention and act without navigating through complicated menus.

Below is the detailed product structure. It expands the restaurant sector in your existing blueprint into a practical scope for design and development. These are proposed capabilities; each needs implementation and validation before being offered as available.

### 1. Product structure

Build one shared restaurant platform with configurable business formats.

| Business format | Additional requirements |
|---|---|
| Dine-in restaurant | Tables, reservations, courses, waiter service, split bills |
| Fast food / takeaway | Fast checkout, queues, combos, pickup screens |
| Café / specialty coffee | Drink modifiers, sizes, beans, brewing recipes, loyalty |
| Bakery / patisserie | Production batches, custom cakes, preorders, shelf life |
| Dessert / ice cream / juice / tea shop | Flavours, toppings, portions, ingredient yields |
| Cloud kitchen | Multiple brands, channel menus, delivery orders, shared kitchen |
| Catering / event catering | Quotations, guest counts, event schedules, equipment, deposits |
| Corporate meal provider | Contract pricing, daily quantities, delivery routes, credit billing |
| Meal subscription company | Meal plans, dietary preferences, pauses, recurring deliveries |
| Food truck | Mobile outlet, limited stock, location schedules, connectivity |
| Home-based food business | Preorders, production capacity, delivery windows, eligibility checks |
| Bar / pub / shisha lounge | Tabs, restricted-item permissions, stock controls, separately reviewed requirements |
| Franchise operator | Brand standards, franchise permissions, royalties, consolidated reporting |
| Food court operator | Tenant outlets, shared seating, settlement and operator-specific agreements |

A business format changes its workflow and settings. It should reuse the same underlying customer, purchasing, inventory, payment, approval, and accounting engines.

### 2. Organisation and user accounts

Use this hierarchy:

**Customer organisation → legal entity → brand → outlet → kitchen / stock location → service station**

This supports a company operating several brands from one kitchen, or several branches under one brand.

Every transaction must identify the relevant tenant, legal entity, outlet, and business date.

| Role | Main access |
|---|---|
| Owner | Consolidated results, approvals, configuration, exceptions |
| General manager | Operations across assigned outlets |
| Outlet manager | Outlet performance, shifts, controlled discounts and refunds |
| Cashier | Orders, bills, permitted payment actions, till session |
| Waiter | Assigned tables, orders, kitchen requests |
| Chef / kitchen supervisor | Tickets, production, availability, recipe access |
| Purchasing officer | Supplier comparison, purchase orders |
| Storekeeper | Receiving, stock, transfers, counts |
| Accountant | Reconciliation, financial posting, tax reporting |
| Food safety responsible person | Checklists, incidents, corrective actions |
| HR administrator | Staff, attendance, restricted payroll access |
| Delivery dispatcher / driver | Assigned deliveries and delivery evidence |
| Franchise operator | Only authorised brands and outlets |

Permissions must distinguish viewing, creating, editing, approving, exporting, refunding, and deleting. Salary information, supplier bank details, and owner reports need separate access controls.

### 3. Owner dashboard

Make the dashboard the default screen after login.

**Primary cards**

- Sales today, compared with a clearly defined comparable period.
- Completed orders and average order value.
- Open tables, pending pickup, and delayed delivery orders.
- Collected payments and unsettled channel balances.
- Estimated food cost and contribution.
- Stock shortages, expiry risks, and wastage.
- Staffing exceptions.
- Approvals and food safety tasks requiring attention.

**Action cards**

Examples: “Approve purchase,” “Review refund,” “Investigate cash shortage,” “Replenish ingredient,” and “Review delayed orders.”

Each card opens the exact records behind the number. Define whether a figure includes tax, cancelled orders, refunds, and unsettled transactions.

Do not label an estimate as net profit.

### 4. Menu, products, and pricing

**Menu structure**

Categories → items → variants → modifier groups → individual modifiers.

Examples:

- Burger → single / double.
- Coffee → small / medium / large.
- Milk choice → dairy / oat.
- Add-ons → cheese / extra shot.
- Combo → main item + drink + side.

Each item should contain:

- Stable item ID and display names.
- English / Arabic descriptions where required.
- Brand and outlet availability.
- Selling prices by channel.
- Recipe version.
- Preparation stations and estimated preparation time.
- Allergens and reviewed dietary information.
- Packaging requirements.
- Availability schedule.
- Tax configuration.
- Images and channel-specific descriptions.

**Important rules**

- Required modifiers must be selected.
- Modifier minimums and maximums are enforced.
- Added ingredients affect cost and consumption.
- Accepted orders preserve their original prices and recipe versions.
- Price changes do not rewrite historical sales.
- Sold-out status can differ by outlet.

For VAT-registered businesses, consumer-facing prices and invoice formats need configuration consistent with applicable FTA requirements; the FTA specifically addresses VAT-inclusive advertised food-menu prices. [tax.gov.ae](https://tax.gov.ae/DataFolder/Files/Pdf/2022/Get%20to%20know%20your%20Tax%20Obligations.pdf?utm_source=chatgpt.com)

### 5. POS and order management

Support:

- Dine-in, takeaway, pickup, delivery, preorder, and catering orders.
- Touch-friendly item selection and search.
- Custom notes with prominent kitchen visibility.
- Combos, modifiers, discounts, vouchers, and loyalty redemption.
- Customer identification when appropriate.
- Held orders and authorised transfers.
- Separate order status, fulfilment status, and payment status.

**Recommended order lifecycle**

Draft → accepted → released to kitchen → preparing → ready → served / collected / dispatched → completed.

Cancellation and rejection are separate paths. Payment can occur before or after preparation depending on the service model.

**Critical controls**

- Cancellation before preparation differs from disposal after preparation.
- A refund does not automatically restore consumed food.
- Reprinting a ticket must clearly identify it as a reprint.
- Duplicate channel events must not create duplicate orders.
- Changes after kitchen release generate amendment tickets.

### 6. Dine-in and table service

Features:

- Floor plan and configurable tables.
- Table availability, seating, and occupancy.
- Reservations, walk-ins, waitlist, and no-shows.
- Party size, customer notes, and deposit policy.
- Waiter assignment.
- Course sequencing and “hold / fire” instructions.
- Table merge and transfer with history.
- Split bills by item, seat, or amount.
- Service recovery and manager intervention.
- Table-turnover reporting.

**Example**

Four guests share a table. Two settle selected items and leave. The remaining items stay open, with the original order history and kitchen tickets preserved.

### 7. Kitchen Display System

Create separate station views for grill, hot kitchen, cold kitchen, bakery, drinks, and dispatch.

Features:

- Accepted tickets with channel, table, priority, and promised time.
- Modifier and allergen visibility.
- Preparation timers.
- Station-level progress.
- Course release.
- Expeditor view combining several stations.
- Remake tickets linked to the original item.
- Delay reasons and bottleneck reporting.
- Printer fallback and connection health.

The system should distinguish “prepared,” “ready for handover,” and “handed over.” Marking one station complete must not prematurely complete the entire order.

### 8. Recipes, production, and food costing

Each recipe needs:

- Version and effective date.
- Ingredient quantities and measurement units.
- Unit conversions.
- Usable yield and preparation loss.
- Sub-recipes such as sauces and dough.
- Portion yield.
- Modifier additions and substitutions.
- Packaging cost.
- Approved preparation instructions.

**Cost definitions**

| Measure | Meaning |
|---|---|
| Standard recipe cost | Expected cost using the approved recipe and costing basis |
| Theoretical consumption | Expected consumption from recorded production and sales |
| Actual consumption | Inventory consumption derived from receipts, movements, counts, and adjustments |
| Consumption variance | Difference between actual and theoretical consumption |
| Channel contribution | Net sales less defined food, packaging, commission, and variable fulfilment costs |

**Illustrative calculation**

A dish has:

- AED 24 selling price before tax.
- AED 7 ingredient cost.
- AED 1 packaging cost.
- AED 5 channel commission.
- AED 2 other variable fulfilment cost.

Its contribution is **AED 9**, before rent, salaries, utilities, overhead, and other excluded costs.

For batch preparation, ingredients move into a prepared product or sub-recipe. Later sales consume that prepared product. Do not deduct the original ingredients again.

### 9. Inventory and stock locations

Track:

- Ingredients, packaging, prepared foods, consumables, and merchandise.
- Outlet stores, central warehouse, central kitchen, preparation areas.
- Supplier lots, internal batches, expiry dates, and storage conditions.
- Stock reservations.
- Receipts, issues, transfers, returns, wastage, and adjustments.
- Counts and variance approvals.
- Reorder levels and stock-cover estimates.
- Quarantine and recall status.

**Essential controls**

- Expired or quarantined stock cannot be allocated as usable stock.
- FEFO allocation follows configured rules.
- Transfers require dispatch and receiving evidence.
- Negative-stock behaviour is explicitly configured.
- Every adjustment records reason and authorisation.
- Stock availability must account for reserved orders and production.

Ingredient availability can suggest that an item is sold out, but the rule must consider prepared stock, approved substitutions, and actual yield.

### 10. Supplier procurement

Workflow:

Purchase request → supplier comparison → approval → purchase order → receipt / inspection → invoice matching → payment.

Supplier records should include:

- Products, pack sizes, prices, and delivery schedules.
- Minimum quantities.
- Credit terms.
- Lead times.
- Approved substitutions.
- Quality and delivery history.
- Relevant documents and expiry reminders.

At receiving, record quantity, condition, batch, expiry, and required inspection evidence.

Handle partial deliveries, rejected goods, price differences, missing invoices, and supplier credits. A purchase order becoming “received” must not automatically prove the invoice is correct or paid.

### 11. Central kitchen and production planning

Support:

- Branch demand requests.
- Production forecasts and confirmed production orders.
- Batch recipes and capacity.
- Material reservation and issue.
- Actual yield, rejects, and wastage.
- Packaging and labelling.
- Dispatch to branches.
- Branch acceptance and shortage claims.
- Batch genealogy.

**Important distinction**

Movement between branches of one legal entity may be an internal transfer. Movement between different legal entities may require intercompany commercial and accounting treatment.

Configure that deliberately.

### 12. Delivery and online channels

Support direct website / QR orders, WhatsApp-assisted orders, own delivery, and contracted marketplace channels.

Features:

- Channel-specific menus and prices.
- Availability and opening hours.
- Order acknowledgement and acceptance.
- Delivery address and service-zone checks.
- Preparation and pickup promises.
- Rider assignment.
- Handover evidence.
- Delivery status and failed-delivery handling.
- Customer notifications.
- Refund and settlement reconciliation.

Integrations should use authorised provider access. API availability, fees, hardware, and partner approval must be verified before offering a connector.

**Marketplace reconciliation**

Record gross sales, merchant discounts, platform-funded promotions, commissions, adjustments, refunds, and payouts separately.

A platform payout is not the same as sales revenue.

### 13. Catering and corporate meals

Catering needs a dedicated commercial workflow:

Enquiry → event requirements → menu proposal → costing → quotation → approval / deposit → production → dispatch → service → final settlement.

Include:

- Event date, venue, guest count, and final-count deadline.
- Dietary requirements and reviewed allergen information.
- Staffing, transport, setup, and equipment.
- Rentals and return inspections.
- Quotation versions and change orders.
- Deposit and cancellation terms.
- Production schedules.
- Delivery / service evidence.
- Final invoice and customer feedback.

Corporate meals also need contracts, daily quantity cutoffs, site schedules, meal acceptance, customer purchase-order references, and consolidated credit billing.

### 14. Meal subscriptions

Support:

- Plans and meal entitlements.
- Delivery days and windows.
- Menu selections and cutoff times.
- Reviewed dietary preferences.
- Pause, resume, skip, and cancellation.
- Address changes.
- Credits and refunds.
- Recurring payment status.
- Route planning.

Separate the subscription contract, payment, meal entitlement, and individual delivery.

A failed renewal must not silently charge the customer twice or create meals without a valid entitlement.

### 15. Food safety and traceability

Provide operational recordkeeping for:

- Supplier approval and receiving checks.
- Storage, preparation, cleaning, and inspection records.
- Temperature readings and exception actions.
- Equipment calibration and maintenance.
- Pest-control records.
- Staff training and relevant document reminders.
- Allergen-information review.
- Incidents, complaints, quarantine, and recall.
- Corrective actions and responsible-person approval.

Thresholds and forms must follow the establishment’s approved food safety plan and relevant authority requirements.

Dubai Municipality describes the responsible Person in Charge as supervising food-safety operations and sharing reports through Foodwatch. DigitalBurj can support the underlying records; direct Foodwatch submission should remain a separately validated integration. [dm.gov.ae](https://www.dm.gov.ae/dubai-municipality-oversees-more-than-70000-mandatory-pics-in-dubais-food-establishments/?utm_source=chatgpt.com)

**AI must not independently declare food safe or release quarantined stock.**

### 16. Staff, shifts, and payroll

Features:

- Staff profiles and outlet assignments.
- Skills and station qualifications.
- Availability and shift planning.
- Attendance and breaks.
- Leave and replacement shifts.
- Overtime approval.
- Training reminders.
- Tips distribution under an approved policy.
- Payroll preparation and restricted payslip access.
- Applicable WPS export / integration after validation.

Track staffing coverage against expected demand. Avoid exposing individual salaries to outlet users who only need shift information.

### 17. Payments, accounting, and financial control

Payment methods may include cash, cards, online gateways, vouchers, gift balances, and approved customer credit.

Required controls:

- Till sessions and opening floats.
- Cash movements and closing counts.
- Split tenders.
- Verified card / online payment status.
- Refund authorisation.
- Chargebacks.
- Customer advances and catering deposits.
- Supplier payables.
- Bank and marketplace settlement reconciliation.
- Financial-period controls.
- Tax invoices and credit notes.
- Ledger integration or validated double-entry posting.

Keep tips, deposits, tax, sales, commissions, and bank payouts distinct.

UAE e-invoicing scope must be assessed for the relevant transactions and business phase. The FTA identifies the Ministry of Finance portal as the official programme source; a receipt printer or emailed PDF alone should not be advertised as an e-invoicing integration. [Uae E-Invoicing](https://tax.gov.ae/en/content/uae.einvoicing.aspx?utm_source=chatgpt.com)

### 18. Customer relationships and marketing

Features:

- Consent-based customer profiles.
- Order and visit history.
- Loyalty points and redemption ledger.
- Gift cards and store credit.
- Feedback, complaints, and service recovery.
- Occasion reminders with consent.
- Campaign audience selection.
- Coupons with budget and eligibility rules.
- Campaign attribution using observable data.

Prevent repeated coupon redemption, unauthorised credit issuance, and messages after opt-out.

Avoid promising allergy-safe meals based solely on a customer-profile flag.

### 19. AI agents and automation

| Agent | Useful action | Control |
|---|---|---|
| Owner briefing | Summarises sales, shortages, delays, and exceptions | Uses verified queries |
| Demand assistant | Forecasts demand and explains uncertainty | Manager reviews production decisions |
| Purchasing assistant | Suggests quantities and compares supplier offers | Approval before ordering |
| Menu-cost assistant | Flags rising cost and weak contribution | No autonomous price changes |
| Document intake | Extracts supplier invoice information | Validation before posting |
| Reconciliation assistant | Proposes settlement and invoice matches | Accountant approves exceptions |
| Customer assistant | Answers approved menu / booking questions | Escalates uncertain allergen questions |
| Communication drafter | Drafts replies and campaigns | Approved sending rules |
| Kitchen exception assistant | Highlights overdue tickets | Cannot invent preparation status |
| Wastage assistant | Identifies patterns and proposes investigation | No automatic safety decision |

Use deterministic automation for timers, totals, permission checks, stock thresholds, and scheduled reminders. AI adds value through language, document interpretation, and forecasts.

### 20. Screens and navigation

**Home:** owner / role-specific dashboard.

**Workspaces:**

1. Orders & POS.
2. Tables & Reservations.
3. Kitchen.
4. Delivery.
5. Menu & Recipes.
6. Production.
7. Inventory.
8. Purchasing.
9. Catering & Subscriptions.
10. Customers & Loyalty.
11. Staff.
12. Finance.
13. Food Safety.
14. Reports.
15. Settings & Integrations.

Use cards to enter workspaces. Inside operational workspaces, use clear tables, forms, queues, and timelines. Preserve quick search and recent activity.

### 21. Core database structure

| Domain | Principal entities |
|---|---|
| Organisation | Tenant, legal entity, brand, outlet, location, station |
| Access | User, membership, role, permission, delegation |
| Menu | Menu, item, variant, modifier group, modifier, price version |
| Recipes | Recipe version, ingredient line, sub-recipe, yield |
| Orders | Order, line, modifier snapshot, fulfilment, amendment |
| Dine-in | Table, reservation, seating, course |
| Kitchen | Ticket, station task, preparation event, remake |
| Inventory | Ingredient, lot, stock movement, reservation, count, wastage |
| Procurement | Supplier, offer, purchase order, receipt, bill |
| Production | Batch, material issue, output, inspection, transfer |
| Payments | Payment attempt, capture, allocation, refund, settlement |
| Finance | Invoice, credit note, journal, journal line, reconciliation |
| Customers | Profile, consent, loyalty movement, complaint |
| Workforce | Staff, shift, attendance, leave, payroll run |
| Safety | Checklist version, reading, incident, corrective action |
| Catering | Event, quote version, guest count, equipment allocation |
| Subscriptions | Plan, contract, entitlement, scheduled meal, pause |
| Integrations | Credential reference, external ID, callback, outbox task |
| Audit | Actor, action, record version, reason, timestamp |

Historical prices, recipes, approvals, and tax calculations need snapshots or version references.

### 22. Critical operating rules

These must be written before coding:

- One external order creates one internal order.
- One verified payment event updates financial records once.
- Confirmed table bookings cannot conflict.
- Prepared food is not restored to stock by a refund.
- Remakes create additional consumption or explicit wastage.
- Material order changes invalidate relevant approval.
- Quarantined stock cannot be released by an ordinary cashier.
- Outlet users cannot access another customer’s records.
- Closed financial records are corrected through controlled reversals.
- Loyalty and gift balances derive from recorded movements.
- Offline actions have visible pending / failed / synced states.
- Offline card acceptance follows the payment provider’s actual capability.
- Kitchen and payment status cannot be inferred from a customer clicking a link.

### 23. Reporting

Build reports for:

- Sales by outlet, item, hour, channel, and service type.
- Refunds, voids, discounts, and reasons.
- Table turnover and preparation delays.
- Recipe margin and channel contribution.
- Theoretical versus actual ingredient consumption.
- Wastage and expiry.
- Supplier price changes and delivery performance.
- Cash variance and unsettled payments.
- Labour hours and staffing coverage.
- Catering profitability.
- Subscription fulfilment.
- Safety tasks and corrective-action closure.

Show the calculation definition and drill-down evidence for every report.

### 24. Development and rollout sequence

| Phase | Deliverable | Exit condition |
|---|---|---|
| 1 | Discovery, organisation, permissions, menu, baseline data | Customer-approved workflow and sample records |
| 2 | POS, order lifecycle, kitchen tickets, payment records | Complete order-to-handover workflow |
| 3 | Recipes, purchasing, inventory, wastage | Quantities and costs reconcile |
| 4 | Accounting, settlement, refund controls | Financial scenarios approved |
| 5 | Delivery, catering, subscriptions, central kitchen | Each selected extension passes its own acceptance cases |
| 6 | AI, forecasting, loyalty, multi-outlet optimisation | Measured benefit and controlled failures |
| 7 | Repeatable commercial rollout | Migration, recovery, hardware, training, and support proven |

Start with **one outlet and one business format**. Add formats through validated extensions.

### 25. Minimum acceptance scenarios

Before launch, demonstrate:

1. An order with modifiers reaches the correct kitchen stations.
2. An unavailable ingredient blocks or changes availability correctly.
3. A cancellation before preparation consumes no food.
4. A cancellation after preparation records the appropriate loss.
5. A remake produces additional consumption.
6. A partial refund changes only the correct payment and sale amounts.
7. A split bill reconciles without double charging.
8. A duplicate channel callback creates no duplicate order.
9. A partial supplier delivery preserves the remaining order balance.
10. A batch production run avoids double ingredient deduction.
11. An expiry / quarantine block prevents allocation.
12. A till shortage appears in the closing report.
13. A marketplace payout reconciles fees and adjustments.
14. Tenant and outlet permissions hold across exports and files.
15. A backup restores orders, attachments, stock, and financial records.

**The first sellable package should be POS + kitchen + recipes + purchasing + stock + payment reconciliation + owner dashboard.** That connects daily restaurant activity to the money and ingredients behind it, while providing a sound foundation for delivery, catering, subscriptions, and AI.

Expanded from the current restaurant sector and its 22 customer profiles:

:chatgpt-content-reference{index="4"}