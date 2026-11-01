# Changelog

What changed in each release of ConnectLocal for Cloudways. Add new notes under **Unreleased**; `npm run release`
turns that section into the new version's entry and uses it as the GitHub release notes.

## Unreleased

- Pushing to a folder whose path has a space no longer splits the path on the server, which could make a push
  with **Delete files on Cloudways that are not in Local** land in the wrong folder.
- The database backup made before a push now goes in a folder of its own for each site (`.cloudways-connect/…` in the
  app's `tmp/` folder). A WordPress installed in a subfolder of an app no longer keeps its dumps inside the main
  site's `public_html`, and no longer shares a backup with the main site.
- A database push into a database that also holds another site's tables (a different table prefix) replaces only this
  site's tables instead of resetting the whole database, and stops before changing anything if the Local site's table
  prefix would overwrite the other site's tables. A pull downloads only this site's tables.

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
