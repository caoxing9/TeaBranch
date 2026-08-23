# Homebrew cask for TeaBranch.
#
# This lives in the app's own repository rather than a `homebrew-tap` repo, so the tap has to be
# added by URL:
#
#     brew tap caoxing9/teabranch https://github.com/caoxing9/TeaBranch
#     brew install --cask teabranch --no-quarantine
#
# `--no-quarantine` is not optional here, and it is worth knowing why. Homebrew stamps every cask
# it downloads with `com.apple.quarantine`, and this build is ad-hoc signed rather than notarized
# (that needs a paid Developer ID), so without the flag Gatekeeper still refuses the first launch —
# installing through Homebrew would move the "open anyway" dance rather than remove it.
#
# `version` and `sha256` are rewritten by the release workflow; don't hand-edit them.
cask "teabranch" do
  version "0.10.0"
  sha256 "d8c7458689699d7b84f0ad9120f746b6f4335d6e38fb065b72456d83228528e6"

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

  uninstall quit: "com.teabranch.dev"

  zap trash: [
    "~/Library/Application Support/com.teabranch.dev",
    "~/Library/Preferences/com.teabranch.dev.plist",
    "~/Library/Saved Application State/com.teabranch.dev.savedState",
  ]
end
