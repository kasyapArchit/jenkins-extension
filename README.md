# Jenkins Launcher

A Manifest V3 Chrome extension that triggers starred Jenkins pipelines from the toolbar
and tracks the resulting builds. No build step, no bundler. Load it unpacked and edit
the files directly.

## Install

1. Open `chrome://extensions`, turn on Developer mode.
2. Load unpacked, pick this directory.
3. Click the toolbar icon, then the gear, and fill in:
   - Jenkins base URL
   - your Jenkins user ID
   - an API token from `<jenkins>/me/security`
4. Hit Test connection. It should report the account it authenticated as.

Chrome will ask for permission to talk to your Jenkins host. That grant is why the
manifest only asks for `optional_host_permissions` instead of a blanket origin.

## Starring a pipeline

Paste any Jenkins URL that contains the job into the box at the bottom of the popup.
A build URL, a console URL, or the job page all work. The extension trims it down to
the job path and pulls the parameter definitions from
`/api/json?tree=property[parameterDefinitions[...]]`.

## Running

- **Run** fires immediately using the last values you used, falling back to the job's
  own defaults on the first run. This is the one-click path.
- The caret opens the parameter form if you need to change something before triggering.
- **Sync params** re-reads the definitions after someone edits the Jenkinsfile.

Password parameters are sent to Jenkins but never written to extension storage, so
they are blank every time.

## Status tracking

Triggering records the queue item URL from the `Location` response header. A
`chrome.alarms` job polls `queue/item/<id>/api/json` until Jenkins assigns a build
number, then polls the build until `building` goes false. The toolbar badge shows the
number of in-flight builds, and a desktop notification fires on completion. Clicking
the notification opens the build page.

Chrome will not run alarms more often than every 30 seconds, so that is the floor for
the poll interval.

## Auth modes

**API token** (default) sends HTTP basic auth. Jenkins exempts API-token requests from
CSRF, so no crumb is needed.

**Browser session** reuses your Jenkins cookies with `credentials: include` and fetches
a crumb from `/crumbIssuer/api/json` before each POST. Use it if your Jenkins is behind
SSO that blocks token auth. It breaks whenever your session expires.

## Known gaps

- File parameters are not supported. `buildWithParameters` needs multipart for those.
- Multibranch jobs must be starred at the branch level, since the top level is a folder.
- Credentials and Run parameter types render as plain text inputs.
- Nothing here works without VPN reachability to the Jenkins host. See below.

## The VPN question

Chrome has no VPN API, and an extension cannot bind its own traffic to a tunnel.
`chrome.proxy` sets a PAC script for the entire browser profile and needs a proxy that
is reachable without the tunnel, which most corporate VPNs do not offer.

The workable answer is split tunneling at the OS level. With OpenVPN, add to your
profile:

```
route-nopull
route <jenkins-ip> 255.255.255.255
# or the whole subnet:
# route 10.20.0.0 255.255.0.0
```

`route-nopull` tells the client to ignore the server's pushed routes, including any
`redirect-gateway` that would send all traffic through the tunnel. The two lines above
then add back only what you need. The tunnel can stay connected all day without
touching the rest of your traffic, which removes the reason to connect and disconnect
manually.

If the server pushes DNS you need for the Jenkins hostname, `route-nopull` drops that
too. Either use the IP directly, add a `/etc/hosts` entry, or re-add the DNS with
`dhcp-option DNS <server>`.
