# Baton CLI

This application will replace the hosted user's Go CLI path. It will own device
login, project enablement, local capture orchestration, cloud synchronization,
status, continuation bootstrap, and the optional MCP stdio proxy.

It must depend on public shared packages and never be imported by another
application or package.
