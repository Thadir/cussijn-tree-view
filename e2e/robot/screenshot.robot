*** Settings ***
Documentation     Not a CI check - an on-demand generator for
...               docs/screenshot.png (the README's screenshot). Seeds a
...               throwaway profile with entirely synthetic mail (see
...               e2e/fixtures/generate_fixture.py - fake senders,
...               *.test domains, nothing from any real mailbox), opens
...               the real extension against it in a real headless
...               Thunderbird, and captures what's actually on screen.
...               Run via ./e2e/screenshot.sh, not part of ./e2e/run.sh
...               or CI - there's no reason to regenerate an identical
...               image on every push.
Library           CussijnLibrary
Library           OperatingSystem
Suite Teardown    Stop Thunderbird

*** Variables ***
${XPI}                %{XPI_PATH=/dist/cussijn-tree-view.xpi}
${PROFILE_DIR}         %{TB_PROFILE_DIR=/tmp/cussijn-screenshot-profile}
${OUT}                 %{SCREENSHOT_PATH=/work/docs/screenshot.png}

*** Test Cases ***
Capture A Real Screenshot Against Synthetic Mail
    [Documentation]    Seeds fake mail, opens the real treemap against
    ...    it in a real Thunderbird, and saves what's on screen.
    File Should Exist    ${XPI}
    ${count}=    Generate Fixture Profile    ${PROFILE_DIR}
    Log    Seeded ${count} synthetic messages
    Start Thunderbird    ${PROFILE_DIR}
    ${indexed}=    Index Local Inbox
    Should Be Equal As Integers    ${indexed}    ${count}
    Install Extension Temporarily    ${XPI}
    Extension Should Be Active
    Open Extension Page    cussijn.html
    # The page's own loadAccounts()/loadData()/render() run async after
    # navigation - there's no content-side "loaded" signal reachable
    # here (see CussijnLibrary's module docstring), so this is a fixed
    # wait, not a poll.
    Sleep    3s
    Take Screenshot    ${OUT}
    File Should Exist    ${OUT}
