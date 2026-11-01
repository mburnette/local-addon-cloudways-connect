# Changelog

What changed in each release of ConnectLocal for Cloudways. Add new notes under **Unreleased**; `npm run release`
turns that section into the new version's entry and uses it as the GitHub release notes.

## Unreleased

## 1.1.0 - 2026-10-31

- Renamed to ConnectLocal for Cloudways.
- Update checks now work. The add-on looks for new releases on GitHub when Local starts and every 12 hours, and
  shows an **Update** button in its panel when one is out.
- If you installed 0.1.0 from the website, install this version once by hand (**Add-ons → Install from disk**).
  Later updates arrive in the add-on.

## 0.1.0 - 2026-10-31

- First release.
- Push a Local site's files, database, or both to a Cloudways WordPress application.
- Pull them back into an existing Local site, or into a brand-new Local site.
- Compare files on both sides and push or pull only the ones you pick.
- Connect with a Cloudways access token or with SFTP/SSH credentials.
- Take a Cloudways backup before pushing, and clear Cloudways, WordPress and Breeze caches after.
