*** Settings ***
Documentation     Real-Thunderbird smoke test: installs the actual built
...               .xpi (not a mock) into a real, headless Thunderbird
...               over Marionette, and confirms it loads without
...               erroring - see e2e/README.md for exactly what "loads"
...               does and doesn't verify here, and why.
Library           CussijnLibrary
Library           OperatingSystem
Suite Setup       Start Thunderbird    %{TB_PROFILE_DIR=/tmp/cussijn-e2e-profile}
Suite Teardown    Stop Thunderbird

*** Variables ***
${XPI}            %{XPI_PATH=/dist/cussijn-tree-view.xpi}

*** Test Cases ***
Extension Installs And Activates
    [Documentation]    Installs the real .xpi the way "Load Temporary
    ...    Add-on" does and confirms Thunderbird's own AddonManager
    ...    reports it active - catches a broken manifest.json or a
    ...    background.js that throws on load before anything else does.
    File Should Exist    ${XPI}
    Install Extension Temporarily    ${XPI}
    ${info}=    Extension Should Be Active
    Should Be Equal    ${info}[id]    cussijn-tree-view@local

Extension Page Opens Without Erroring
    [Documentation]    Opens cussijn.html as a real tabmail contentTab
    ...    (the same call background.js's openOrFocusView() makes) and
    ...    confirms the tab actually navigated to that exact
    ...    moz-extension:// URL, rather than Thunderbird falling back to
    ...    about:blank/an error page because the extension failed to
    ...    load. This is a load-time smoke check, not a content
    ...    assertion - see e2e/README.md's "Known limitation" for why
    ...    nothing here can yet read what's actually on the page.
    ${expected_url}=    Open Extension Page    cussijn.html
    ${actual_url}=    Get Last Tab Url
    Should Be Equal    ${actual_url}    ${expected_url}
