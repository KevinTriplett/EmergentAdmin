# Agent Prompt: leads.ts

Build `src/tasks/leads.ts` for a Puppeteer automation project.
Build a front end UI per "Admin UI" details below. This UI is separate from the admin UI that we built for adding and removing members from spaces.
Set a cron job for once a day to go through the page at the  Leads URL and harvest new leads per the Harest Process below.
Since each new lead will be sent an email, add a way for a user to change the status of the lead from "Email sent" to "Response received".
Set a cron job for once a week to go through the leads database and for each lead that is still at "Email sent" to go back to the Leads url and decline that lead per the Decline process below.

## Exports

TBD

## Constants

```js
// === CSS SELECTORS — UPDATE THESE IF MN CHANGES ITS DOM ===
const SEL_LEADS_TAB = "[data-tab='leads']";
const SEL_LEADS_HEADINGS = `${SEL_LEADS_TAB} thead`;
const SEL_REVEAL_EMAILS = `${SEL_LEADS TAB} [aria-label='Hide Email column']`;
const SEL_LEAD_ROWS = `${SEL_LEADS_TAB} tbody [data-id='table-row']`;
const SEL_MODAL_CONFIRM = "[data-id='member-privacy-reminder-confirm-button']";
const SEL_ANSWERS_LIST = 'h2#view-answers-dialog-title ~ ol';
const SEL_DECLINE = "ul[role='menu']";
const SEL_DECLINE_SUBMIT = "form[novalidate] button[type='submit']";

const LEADS_HEADINGS = {
   name: 'Name',
   email: 'Email',
   status: 'Status',
   date: 'Date Requested',
   actions: 'Actions'
};

const GREETER_EMAILS = [
   'kt@kevintriplett.com'
];

const EMAIL_GREETERS_SUBJECT = '[Emergent Commons] Greeters: new leads available to check';
const EMAIL_LEAD_SUBJECT = 'Meet a greeter at Emergent Commons';
const EMAIL_LEAD_FROM = 'kt@kevintriplett.com';
const EMAIL_LEAD_BODY = << EOF
Hello,

Thank you for asking to join Emergent Commons.

Before entering, we want to greet you and get to know what interests you in our community so we can help you find what you're looking for. We're a big, diverse group with a Commons and Crews.

The Commons is where we discuss topics of interest to all members and our Crews are where we discuss and practice specific topics and modalities.

Choose a time that suits you using this link:

https://calendly.com/kevintriplett/emergent-commons-welcome

I'm looking forward to greeting you!
Best regards,
Kevin Triplett
EOF

## Leads URL Construction

```
https://emergent-commons.mn.co/settings/invite/requests
```

## Harvest Process

1. Navigate to the invite requests
2. Wait until `SEL_LEAD_ROWS` is present
3. Perform an infinite scroll until MAX_LEADS rows is reached
4. Determine the column index for each LEADS_HEADINGS
   a. This column index will be used to harvest data from each row
5. Reveal all email addresses by clicking SEL_REVEAL_EMAILS
   a. When the SEL_MODAL_CONFIRM is visible, click it
6. Iterate through each row and harvest:
   a. name, email, status, date, and answers per each data's column index
   b. To reveal answers, click the "View Answers" button in the "Actions" column
   c. Answers are the list items in the SEL_ANSWERS_LIST 
7. Once leads in all rows are harvested
   a. For each lead
      1. If lead is not in the database
         a. Add lead to the database with all data harvested
      2. if the lead is in the database and the status value in the database does not matche the value harvested
         a. Update the status in the database
8. If a lead is in the database but was not in the harvested leads
   a. Update the status of that lead in the database to "Declined"
8. Once all leads are processed
   a. Send one email to all GREETER_EMAILS stating in the body that new leads are available and then list each name that was added to the database, along with the Lead URL for the greeter to click, with the email subject set to EMAIL_GREETERS_SUBJECT

## Approve Process from UI
1. Go to the Leads URL and find the lead using the email address (assume all email addresses are unique in the rows of leads)
2. Click the button with "Approve" in the "Actions" column
3. Change the status of the lead in the database to "Joined"

## Decline Process from UI

1. Go to the Leads URL and find the lead using the email address (assume all email addresses are unique in the rows of leads)
2. Click the button with the svg in the "Actions" column
3. Click SEL_DECLINE (if more than one SEL_DECLINE element, record error)
4. Click SEL_DECLINE_SUBMIT
5. Change the status of the lead in the database to "Declined"

## Decline Process from cron

1. For each lead in the database that still has "Email sent" and the email sent date is one month or more old
   a. Go to the Leads URL and find the lead using the email address (assume all email addresses are unique in the rows of leads)
   b. Click the button with the svg in the "Actions" column
   c. Click SEL_DECLINE (if more than one SEL_DECLINE element, record error)
   d. Click SEL_DECLINE_SUBMIT
   e. Change the status of the lead in the database to "Declined"

## Admin UI

Show two tables of leads:
   The first table lists all leads with status "Pending"
      Each row has buttons "Approve", "Decline", "See answers" and "Send email"
      Each row shows the date an email was sent (day only, not time) and how many emails were sent (null = 0)
      When "Send email" is clicked for a lead
         1. Send an email with subject EMAIL_LEAD_SUBJECT with the body EMAIL_LEAD_BODY from EMAIL_LEAD_FROM to each new lead
         2. If the email is sent successfully
            a. Indicate in the database the date of the email sent for that lead
            b. Increment the email counter in the database for that lead
      Note that the EMAIL_LEAD_BODY is using EOF pseudocode that is not `.ts` compliant. I need you to turn this into html for an email to preserve the blank lines and turn the url into a clickable link. If this can be done using plaintext, that's better than html since any email client will likely render it correctly as intended. If this is not the case, tell me during the implementation and I'll make decisions with your help.
   The second table lists all leads and their disposition, whether declined or approved and the date that happened.

## Abort Handling

`abortSignal` is an object with a boolean `.aborted` property. The
server sets it to true when it receives an abort WebSocket message.

Check `abortSignal.aborted` BEFORE each removal attempt (step g).
On abort:
- Log: `"Abort requested. Stopped after ${count} removals."`
- Return `{ success: true, removed: count, error: "Aborted by user after ${count} removals" }`

## Error Handling

- Wrap ALL DOM interactions in try/catch.
- On error: log the error message, close any open modals/dropdowns
  if possible, and return with:
  `{ success: false, removed: count, error: <message> }`
- Do not let an error in one removal crash the entire task without
  reporting how many were already removed.

## Return

```js
{ success: boolean, removed: number, error?: string }
```
