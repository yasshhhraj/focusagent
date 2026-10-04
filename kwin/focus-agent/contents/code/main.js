function report(window) {
  if (!window || window.specialWindow) return;
  const application = window.desktopFileName || window.resourceClass || window.resourceName || "unknown";
  callDBus(
    "dev.yashraj.FocusAgent",
    "/Activity",
    "dev.yashraj.FocusAgent.Activity",
    "ReportWindow",
    String(application),
    String(window.pid || 0),
    String(window.caption || "")
  );
}

workspace.windowActivated.connect(report);
report(workspace.activeWindow);
