# Clarifications to the master prompts

## Variables

Notes:
* vars prefaced with 'url' are https addresses
* vars prefaced with 'txt' are dom elements identified with text
* vars prefaced with 'sel' are css selectors
* vars suffixed with 's' are arrays

### urls

urlLogin = 'https://emergent-commons.mn.co/sign_in'
urlSpaceMembers = `https://emergent-commons.mn.co/spaces/${spaceId}/admin/members/all`
urlMembers = 'https://emergent-commons.mn.co/admin/members/all'


### login page

SEL_READY = 'body.pace-done #community-app'
SEL_SIGN_IN = 'body.auth-sign_in'
SEL_LANDING = 'body.communities-landing'
SEL_GDPR_CONSENT = '#c-p-bn'
SEL_SIGNED_IN = 'body.communities-app'
TXT_LANDING_SIGN_IN = 'Sign In'
TXT_EMAIL = 'Email'
TXT_NEXT = 'Next'
TXT_SIGN_IN_WITH_PASSWORD = 'Sign In with Password'
TXT_PASSWORD = 'Password'

### spaceMembers page

SEL_READY = 'body.pace-done #community-app'
SEL_FLYOUT = '#flyout-main-content'
SEL_TABLE_MEMBERS = '.all-members-list-items'
SEL_MEMBER_ROW = '[data-member-item]'
SEL_MEMBER_DROPDOWN = '.actions-region a.mighty-drop-down-toggle'
SEL_MEMBER_DROPDOWN_MORE = '#menu-list-item-more-host-FlexSpace-actions .toggle-child-expanded-button'
SEL_REMOVE_FROM_SPACE = '#menu-list-item-remove-from-sub-space'
SEL_MODAL_CONFIRM = '#modal-content-region .modal-confirm-button'
SEL_MODAL_CANCEL = '#modal-content-region .modal-reject-button'
SEL_MODAL_REGION = '#modal-content-region'
SEL_NAME_TH = "[title='Member Name']"
SEL_NAME_TD(colIndexName) = `td:nth-child(${colIndexName})`
SEL_MEMBER_ID_TD = `${SEL_NAME_TD(colIndexName)} a`
SEL_JOINED_TH = "[title='Joined Network']"
SEL_JOINED_TD(colIndexJoined) = `td:nth-child(${colIndexJoined})`
SEL_ACTIVE_TH = "[title='Last Active']"
SEL_ACTIVE_TD(colIndexActive) = `td:nth-child(${colIndexActive})`
SEL_NAME_LI = ":has(+ [title='Name']) a"
SEL_JOINED_LI = ":has(+ [title='Joined Network'])"
SEL_ACTIVE_LI = ":has(+ [title='Last Active'])"
SEL_SORTED_BY_DROPDOWN = '.sorted-by-region a.mighty-drop-down-toggle'
SEL_SORTED_BY_LAST_ACTIVE = '#menu-list-item-last_visit_at_desc'

spaceIds = {
    '1. Relating to SELF': '7330330',
    '2. Relating to OTHERS': '7330338',
    '3. Relating to WORLD': '7330342',
    '4. Current Events/Politics/Hot Buttons': '7330344',
    '5. News/Ideas from Crews, Teams, Events': '5285007',
    '6. Personal Introductions  ': '4748980',
    '7. EC Announcements and Highlights': '4747426',
    '8. Miscellaneous': '9325627',
    'Creative Center': '5722465',
    'Marketplace': '5627234'
}

adminIds = [
    '7698608',
    '12314607'
]

### members page

SEL_MEMBER_SEARCH = ".filter-bar-search-region div[aria-label='Search Members']"
SEL_MEMBER_SEARCH_INPUT = ".filter-bar-search-region div[aria-label='Search Members'] input"
SEL_MEMBER_ROW = `[data-member-item='${memberId}']`
SEL_MEMBER_DROPDOWN = `[data-member-item='${memberId}'] .actions-region a.mighty-drop-down-toggle`
SEL_ADD_MEMBER_TO_SPACE = 'a#menu-list-item-add-to-spaces'
SEL_SPACE_LIST_INPUT = ".MuiPaper-root input[placeholder='Choose Spaces']"
SEL_SPACE_LIST_OPTION = ".MuiPopper-root li:firstchild"
SEL_SPACE_TAG = '.MuiBox-root .MuiAutocomplete-tag'
SEL_SPACE_LIST_CLOSE = ".MuiPaper-root button[title='Open']"
SEL_ADD_TO_SPACE_BUTTON = ".MuiPaper-root button[data-id='dialog-confirm-button']"
SEL_TOAST_SUCCESS = '.notifyjs-corner .system-toast-inner.success'

## Processes

### login

1. open urlLogin
1. wait until SEL_READY and SEL_SIGN_IN
1. click SEL_GDPR_CONSENT
1. fill input TXT_EMAIL with env_admin_email env var
1. click element TXT_NEXT
1. click link with TXT_SIGN_IN_WITH_PASSWORD text
1. fill input TXT_PASSWORD with envAdminPw env var
1. click link with TXT_NEXT
1. wait until SEL_READY

### removeSpaceMembers

Arguments: {fullSpaceName: string, dryRun: boolean = false}

Notes:
* selFlyoutId is an infinite scroll region containing the child selTableMembers

1. find spaceId in spaceIds using fullSpaceName key
1. visit urlSpaceMembers
1. wait until SEL_READY
1. login if SEL_SIGN_IN visible
1. for each [data-member-item] !== adminId
    1. click SEL_MEMBER_DROPDOWN
    1. click SEL_MEMBER_DROPDOWN_MORE
    1. click the element with SEL_REMOVE_FROM_SPACE
    1. dryRun ? click SEL_MODAL_CANCEL : click SEL_MODAL_CONFIRM
    1. click SEL_MODAL_OKAY
1. return success or error message per return type

### addSpaceMember

Arguments: {fullMemberName: string, memberId: string, fullSpaceName: string}

1. visit urlSpaceMembers
1. wait until SEL_READY
1. login if SEL_SIGN_IN visible
1. click SEL_MEMBER_SEARCH
1. type fullUserName into SEL_MEMBER_SEARCH_INPUT
1. return with error = 'Already a member' if SEL_MEMBER_ROW found
1. visit urlMembers
1. wait until SEL_READY
1. click SEL_MEMBER_SEARCH
1. type fullUserName into SEL_MEMBER_SEARCH_INPUT
1. click SEL_MEMBER_DROPDOWN
1. click SEL_ADD_MEMBER_TO_SPACE
1. type spaceName into SEL_SPACE_LIST_INPUT
1. click SEL_SPACE_LIST_OPTION
1. check that SEL_SPACE_TAG is visible and contains text spaceName
1. click SEL_SPACE_LIST_CLOSE
1. click SEL_ADD_TO_SPACE_BUTTON
1. Verify SEL_TOAST_SUCCESS contains the string fragment 'will be added'
1. return success or error message per return type

### identifyMembersToAddToSpaces

The purpose of this is to add a member to all the spaces iff they agree to the
community agreements that hold members accountable for how they "show up"
developmentally in all the spaces. To agree requires the member to post a
comment of the form "I agree" on the agreement article. (Historically this
was an 8-article gate; the architecture is N-aware so the threshold is
configurable in `src/config/agreements.ts`, currently set to 1.)

The implementation options:
1. a cron job running every 30 minutes checks all comments on each
agreement to see if any new member has commented on all articles. If so, that
member's name and id is sent to addSpaceMember.
1. Mighty Networks sends an email everytime a member comments on an article. If
the member comments on every article, that member's name and id is sent to
addSpaceMember.

The concerns:
1. The RoR app running on the same server also runs a cron job that uses a
headless browser to scrap the Mighty Networks site looking for new requests
to join the community. This consumes a lot of resources, so running a second
cron job that consumes a lot of resources might not be a good idea.
1. A user might write something different, like, "This is great. Agreed." It
would be difficult to determine if the member is agreeing or disagreeing
so we can delete the comment and send a direct message via Mighty Networks
asking the user to submit a new comment of "I agree". Another option, we could
transform the comment via a regex that looks for "I agree", but it might
transform "I don't agree" into "I agree".
1. The email notification is for a single comment and the body of the email
contains a direct link to the comment which means we have the space id and
the article id which are both embedded in the link. It also have the text of
the comment. So we do not need to visit the site unless it's to do something
like delete the comment and DM the member with the request to report their
comment with the correct text.

Consider these options and concerns and provide guidance.

### collectActiveMemberList

Purpose: export to file the active member list. The task talks to MN's
internal REST endpoint `GET https://emergent-commons.mn.co/api/web/v1/spaces/4747401/members/all`
directly (with `?include_email=true&page=N&per_page=100&sort=last_visit_at&sort_order=desc`).
The earlier selector-based DOM-scraping plan is **superseded**: MN's
admin page is itself a thin wrapper around this API, and the
infinite-scroll loader in the rendered DOM caps at ~50 rows under
programmatic scroll, which made the scraping path unreliable. The
single page-side `fetch(url, { credentials: 'include' })` reuses the
session cookie established by visiting the rendered admin page once
at the top of the run, so no token plumbing is required.

Process:

1. visit urlMembers (warms the session cookie; no data is read from the DOM)
1. waitForSelector SEL_READY (interactive, cookies set)
1. for each API page (1-indexed, `per_page=100`):
    1. `page.evaluate(async (u) => fetch(u, { credentials: 'include' }))`
    1. parse the array response and walk in order
    1. for each member:
        1. if `user.id` is in the EXCLUDED_MEMBER_IDS set (currently `[39358139]` — the Commons Keeper Admin bot account), skip and continue (counts toward `skipped`)
        1. if `user.membership.created_at` < 1 year ago, skip and continue
        1. if `user.network_last_visit_at === null`, break and discard (never-visited)
        1. if `user.network_last_visit_at` < 90 days ago is FALSE (i.e. more than 90 days), break and discard
        1. else keep
    1. stop paginating when the page is empty, the page returned `< per_page` rows, a break decision fired, or `MAX_PAGES=1000` was reached
1. after each page, log a one-time WARNING if the rows are not sorted descending by `last_visit_at` (insurance against MN silently changing the sort honour)
1. write the kept rows to `data/active-members.csv` (header `NAME,MEMBER ID,JOINED,LAST ACTIVE`; dates rendered as `Apr 19, 2025`-style and quoted per RFC 4180), accessed via the token-gated `/downloads/active-members.csv` endpoint

### greetPotentialNewMembers

Purpose: We receive requests to join and part of the new member journey is to be greeted by an existing member before being approved to join. Here's the process:

Process:

1. request to join
    1. email received, request to join
    1. retrieve the answers to the questions
1. Send email 
    1. if answer is yes to being greeted
        1. ask for dates and times available for a greeting
    1. else
        1. ask if accept a greeting
1. email reply received
    1. post in the new member space
        1. the answers to questions
        1. the dates and times suggested
1. a greeter comments
1. greeter comments are emailed
1. reply is posted as reply to greeter comment
1. this can happen as many times as needed for clarification
1. if greeter comments "I will greet"
    1. "I will greet" is not emailed but any text after is emailed
    1. event is posted
    1. email is sent with .ics and nice standard text
1. if greeting takes place
    1. greeter posts a comment of their acceptance or rejection



## Return types

login = { success: boolean, error?: string }
addSpaceMember = { success: boolean, error?: string }
removeSpaceMembers = { success: boolean, error?: string }

## Browser lifecycle

* add debug argument 'headless' default 'true'
* add debug argument 'dryRun' default 'true'
* browser launch/teardown per task addFromList and removeFromSpace

## Miscellaneous

* Add finally block requirement for browser cleanup in server.ts.
* Add an abort mechanism for each task (WebSocket message + flag check between iterations).
* for headless false, make sure abort mechanism activation is always visible and enabled
* for headless true add debug messages showing progress with scroll so abort mechanism activation is always visible
* Add "already a member" handling to addSpaceMember