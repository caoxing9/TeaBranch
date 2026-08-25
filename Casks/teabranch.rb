# Homebrew cask for TeaBranch.
#
# This lives in the app's own repository rather than a `homebrew-tap` repo, so the tap has to be
# added by URL:
#
#     brew tap caoxing9/teabranch https://github.com/caoxing9/TeaBranch
#     brew trust --cask caoxing9/teabranch/teabranch
#     brew install --cask teabranch
#
# About the `postflight` below, because it disables a real protection and should not be silent:
#
# This build is ad-hoc signed, not notarized — notarizing needs a paid Developer ID. The DMG
# arrives quarantined (macOS marks it as downloaded), the app copied out of it inherits that, and
# Gatekeeper then rejects it: `spctl -a` says "rejected" and the first launch needs right-click →
# Open. Homebrew does not change this. Its `--no-quarantine` flag no longer exists, and
# `Quarantine.available?` is hard-coded false in current versions, yet the attribute still comes in
# on the downloaded file itself.
#
# So the cask strips it explicitly. That is the same `xattr -dr` the README has always told people
# to run by hand, moved into the install so it happens once and correctly. It means Gatekeeper does
# not vet this app on your machine — which is a thing to accept knowingly, and the reason to
# eventually pay for a Developer ID instead.
#
# `version` and `sha256` are rewritten by the release workflow; don't hand-edit them.
cask "teabranch" do
  version "0.10.2"
  sha256 "ab93be2a57cb93268bcf936b90c5864b4720772faf70fcc6b017a0c43ac0c6b1"

  url "https://github.com/caoxing9/TeaBranch/releases/download/v#{version}/TeaBranch-#{version}-arm64.dmg",
      verified: "github.com/caoxing9/TeaBranch/"
  name "TeaBranch"
  desc "Run several Teable branches at once, each in its own Git worktree"
  homepage "https://github.com/caoxing9/TeaBranch"

  livecheck do
    url :url
    strategy :github_latest
  end

  # Liquid Glass has no back-deployment path, and there is no Intel slice. A bare symbol already
  # means ">=" here — `macos=` parses with that comparator — and the string spelling is deprecated.
  depends_on macos: :tahoe
  depends_on arch: :arm64

  app "TeaBranch.app"

  postflight do
    system_command "/usr/bin/xattr",
                   args: ["-dr", "com.apple.quarantine", "#{appdir}/TeaBranch.app"],
                   sudo: false
  end

  uninstall quit: "com.teabranch.dev"

  zap trash: [
    "~/Library/Application Support/com.teabranch.dev",
    "~/Library/Preferences/com.teabranch.dev.plist",
    "~/Library/Saved Application State/com.teabranch.dev.savedState",
  ]
end
