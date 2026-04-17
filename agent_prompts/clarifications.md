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
    'Marketplace': '5627234',
    'Playground': '23462808'
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