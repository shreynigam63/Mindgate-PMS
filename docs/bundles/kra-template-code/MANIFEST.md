# MANIFEST — KRA Library template code bundle

Cut from Mindgate-PMS `main` at commit b15595d.

```
5794c4baaa207940  INSTALL.md
cf1b65d198cb2953  files/KRA-Library-Template.xlsx
247051d1715d9d7a  images/kra-template-01-upload-card.png
5f2e51810bc4253c  server/modules/performance/kra-parser-department.section.js
de1f4942dc184a6e  server/modules/performance/kra-template.section.js
2d3f8dfdbb4f2288  server/test/kra-library-template.test.js
```

> **`files/KRA-Library-Template.xlsx` is not byte-reproducible.** ExcelJS
> stamps a creation time into the zip, so two downloads of the identical
> template have different SHAs. Compare the **cell values**, not the hash:
>
> ```
> sheet       KRA Library      rowCount  5
> row 1       banner, 590 chars, states "carries down"
> row 2       Department | Designation | Parameters | KRA (S.M.A.R.T GOALS)
>             | KPIs (Measuring Metrics & Data Source) | Suggested Weightage | Comments
> rows 3-5    Admin | Manager | Financial/Customer/People | ... | 20/25/15 | Delete this sample row
> ```
>
> The `.js` and `.md` files above ARE byte-reproducible; check those hashes
> normally.
