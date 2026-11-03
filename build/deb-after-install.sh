#!/bin/bash
# deb postinst. Based on the electron-builder template
# (app-builder-lib/templates/linux/after-install.tpl) with one change:
# chrome-sandbox is switched to setuid UNCONDITIONALLY.
#
# The template's test (`unshare --user true`) gives a false positive on
# Ubuntu 23.10+/24.04: AppArmor allows a user namespace to be created, but
# without capabilities, and Electron then aborts at startup
# (FATAL:setuid_sandbox_host). The setuid sandbox helper is required on such
# systems, so always chmod 4755.

if type update-alternatives >/dev/null 2>&1; then
    # Remove previous link if it doesn't use update-alternatives
    if [ -L '/usr/bin/lucidssh' -a -e '/usr/bin/lucidssh' -a "`readlink '/usr/bin/lucidssh'`" != '/etc/alternatives/lucidssh' ]; then
        rm -f '/usr/bin/lucidssh'
    fi
    update-alternatives --install '/usr/bin/lucidssh' 'lucidssh' '/opt/LucidSSH/lucidssh' 100 || ln -sf '/opt/LucidSSH/lucidssh' '/usr/bin/lucidssh'
else
    ln -sf '/opt/LucidSSH/lucidssh' '/usr/bin/lucidssh'
fi

chmod 4755 '/opt/LucidSSH/chrome-sandbox' || true

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi

# Install apparmor profile. (Ubuntu 24+)
# First check if the version of AppArmor running on the device supports our profile.
# This is in order to keep backwards compatibility with Ubuntu 22.04 which does not support abi/4.0.
# In that case, we just skip installing the profile since the app runs fine without it on 22.04.
if apparmor_status --enabled > /dev/null 2>&1; then
  APPARMOR_PROFILE_SOURCE='/opt/LucidSSH/resources/apparmor-profile'
  APPARMOR_PROFILE_TARGET='/etc/apparmor.d/lucidssh'
  if apparmor_parser --skip-kernel-load --debug "$APPARMOR_PROFILE_SOURCE" > /dev/null 2>&1; then
    cp -f "$APPARMOR_PROFILE_SOURCE" "$APPARMOR_PROFILE_TARGET"

    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      apparmor_parser --replace --write-cache --skip-read-cache "$APPARMOR_PROFILE_TARGET"
    fi
  else
    echo "Skipping the installation of the AppArmor profile as this version of AppArmor does not seem to support the bundled profile"
  fi
fi
