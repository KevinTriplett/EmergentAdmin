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
SEL_NAME_TD = `td:nth-child(${colIndexName})`
SEL_MEMBER_ID_TD
SEL_JOINED_TH = "[title='Joined Network']"
SEL_NAME_TD = `td:nth-child(${colIndexJoined})`
SEL_ACTIVE_TH = "[title='Last Active']"
SEL_NAME_TD = `td:nth-child(${colIndexActive})`
SEL_NAME_LI = ":has(+ [title='Name'])"
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

Purpose: export to file the active member list from scraping the urlMembers page. The page is an infinite scroll and is either a table with columns or unordered list with divs nested within <li> elements, depending upon viewport size.

Process:

1. visit urlMembers
1. determine whether SEL_TABLE_MEMBERS is a <table> or <ul> in order to use the correct SEL_ for each member iteration
1. click the SEL_SORTED_BY_DROPDOWN
1. click the SEL_SORTED_BY_LAST_ACTIVE
1. wait for SEL_TABLE_MEMBERS to be re-rendered
1. scroll SEL_TABLE_MEMBERS until finished (look for how this is done in other tasks)
1. for each SEL_MEMBER_ROW starting with the first member
    1. get the name via `textContent.trim()` using SEL_NAME_* (note: use SEL_NAME_TD for tables and SEL_NAME_LI for lists)
    1. get the text-formatted date via `textContent.trim()` using SEL_JOINED_* (note: SEL_JOINED_TD or SEL_JOINED_LI)
    1. get the text-formatted date via `textContent.trim()` using SEL_ACTIVE_* (note: SEL_ACTIVE_TD and SEL_ACTIVE_LI)
    1. if either the SEL_ACTIVE date is more than 90 days prior to today's date or SEL_JOINED is more than 1 year prior to today's date, break out of the loop and discard this member's data
1. write the data to a csv file in the public directory on the server with header row "NAME, JOINED, LAST ACTIVE"



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