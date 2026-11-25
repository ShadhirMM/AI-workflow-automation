# Health tab (Google Sheets)

S3 reads one row of counts from this tab instead of counting rows in Make, which keeps the scenario small. The formulas match `computeHealth()` in `src/scheduled.js`.

Create a tab named **Health**. Row 1 holds the headers below. Paste the formulas into row 2.

Make writes RunLog times as `YYYY-MM-DDTHH:mm:ss` in **Asia/Dubai** time: `{{formatDate(now; "YYYY-MM-DDTHH:mm:ss"; "Asia/Dubai")}}`. Set the spreadsheet time zone to Dubai as well (File → Settings).

| Col | Header | Formula (row 2) |
|---|---|---|
| A | `since` | `=TEXT(NOW()-1,"yyyy-mm-dd")&"T"&TEXT(NOW()-1,"HH:mm:ss")` |
| B | `processed_24h` | `=SUMPRODUCT((RunLog!A2:A>=A2)*(RunLog!G2:G<>"duplicate")*(RunLog!G2:G<>"heartbeat")*(RunLog!G2:G<>""))` |
| C | `review_24h` | `=SUMPRODUCT((RunLog!A2:A>=A2)*(RunLog!G2:G="review"))` |
| D | `retries_24h` | `=SUMPRODUCT((RunLog!A2:A>=A2)*N(+RunLog!H2:H))` |
| E | `open_dead_letters` | `=COUNTIF(DeadLetter!K2:K,"open")` |
| F | `open_review` | `=COUNTIF(ReviewQueue!H2:H,"open")` |
| G | `last_run` | `=MAX(ARRAYFORMULA(IFERROR(DATEVALUE(LEFT(RunLog!A2:A,10))+TIMEVALUE(MID(RunLog!A2:A,12,8)))))` |
| H | `hours_since_run` | `=IF(G2=0,9999,ROUND((NOW()-G2)*24,1))` |

Column letters follow the CSV headers in `sheets/` (RunLog: A=time, G=outcome, H=retries; DeadLetter: K=status; ReviewQueue: H=status). If you add columns, update the letters.

Thresholds (Config tab): ALERT when `open_dead_letters > 0`, the watchdog fired, or `hours_since_run > 24`. WARNING when `open_review ≥ 5` or `retries_24h > 0`.
