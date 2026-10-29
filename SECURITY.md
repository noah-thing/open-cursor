# Security

Please do not report security problems in public issues.

Report them privately through GitHub: open the **Security** tab of this repository and choose **Report a vulnerability**. Include what you found, how to reproduce it, and which version you used. You will get a reply as soon as possible, and a fix is released before the details are made public.

OpenCursor stores API keys in the system keychain and sends them only to the provider they belong to. Anything that could leak a key, run a command without the approval the user chose, or reach a file outside the open project is in scope.
