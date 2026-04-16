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

selReady = 'body.pace-done #community-app'
selSignIn = 'body.auth-sign_in'
selGdprConsent = '#c-p-bn'
txtEmail = 'Email'
txtNext = 'Next'
txtSignInWithPassword = 'Sign In with Password'
txtPassword = 'Password'
selSignedIn = 'body.communities-app'

### spaceMembers page

selFlyoutId = '#flyout-main-content'
selTableMembers = '.all-members-list-items'
selMemberDropdown = '.actions-region a.mighty-drop-down-toggle'
selMemberDowndownMore = '.actions-region .mighty-drop-down-menu-region .menu-list-item-more-host-FlexSpace-actions .toggle-child-expanded-button'
txtRemoveMember = 'Remove from Space'
txtRemoveModalConfirm = 'Remove This Member'
txtRemoveModalCancel = 'Cancel'
txtRemoveModalOkay = 'Okay'

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
    '7698608'
]

### members page

selSearch = ".filter-bar-search-region div[aria-label='Search Members']"
selSearchInput = ".filter-bar-search-region div[aria-label='Search Members'] input"
selMember = `.all-members-list table tbody tr:has(td a[title='${fullMemberName}'])`
selMemberDropdown = `${selMember} .actions-region a.mighty-drop-down-toggle`
selAddToSpace = '.mighty-drop-down-items-container a#menu-list-item-add-to-spaces'
selSpaceInput = "input[placeholder='Choose Spaces']"
selOption0 = ".MuiPopper-root ul[role='listbox'] li[data-option-index='0'] input.PrivateSwitchBase-input"
selClose = ".MuiPaper-root button[title='Open']"
txtAddToSpace = 'Add to Space(s)'
selToastSuccess = '.notifyjs-corner .system-toast-inner.success'

## Processes

### login

1. open urlLogin
1. wait until selReady and selSignIn
1. click selGdprConsent
1. fill input txtEmail with env_admin_email env var
1. click element txtNext
1. click link with txtSignInWithPassword text
1. fill input txtPassword with envAdminPw env var
1. click link with txtNext
1. wait until selReady

### removeSpaceMembers

Arguments: {fullSpaceName: string, dryRun: boolean = false}

Notes:
* selFlyoutId is an infinite scroll region containing the child selTableMembers

1. find spaceId in spaceIds using fullSpaceName key
1. visit urlSpaceMembers
1. wait until selReady
1. login if selSignIn visible
1. for each tr[data-member-item] !== adminId
    1. click selMemberDropdown
    1. click selMemberDropdownMore
    1. click the element with txtRemoveMember
    1. dryRun ? click txtRemoveModalCancel : click txtRemoveModalConfirm
    1. click txtRemoveModalOkay
1. return success or error per return type

### addSpaceMember

Arguments: {fullMemberName: string, fullSpaceName: string}

1. visit urlSpaceMembers
1. wait until selReady
1. login if selSignIn visible
1. click selSearch
1. type fullUserName into selSearchInput
1. return with error = 'Already a member' if selMember found
1. visit urlMembers
1. wait until selReady
1. click selSearch
1. type fullUserName into selSearchInput
1. click selMemberDropdown
1. click selAddToSpace
1. type spaceName into selSpaceInput
1. click selOption0
1. click selClose
1. click txtAddToSpace
1. Verify selToastSuccess contains the string fragment 'will be added'
1. return success or error per return type

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