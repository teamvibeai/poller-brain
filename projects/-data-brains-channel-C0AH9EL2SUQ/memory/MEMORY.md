# Memory – Channel C0AH9EL2SUQ (Infodental)

## Klíčová instrukce
- **Vždy ukládat poznámky do KB** po každém tasku nebo důležitém zjištění
- KB = tento soubor `/data/base-brain/projects/-data-brains-channel-C0AH9EL2SUQ/memory/MEMORY.md`

## Projekt
- Repo: `infodentalcz/infodental` (GitHub, soukromé)
- Default branch: `develop`
- Persistent workspace: `/data/workspace/infodental/` (perzistentní disk `/data`)
- Stack: React + TypeScript + Ant Design + Tailwind CSS (monorepo, frontend v `packages/frontend/src/`)

## Zahájení práce na tasku (po restartu kontejneru)

1. Ověř, zda repo existuje: `ls /data/workspace/infodental/`
2. Pokud ne, naklonuj: `GH_TOKEN=$GITHUB_TOKEN /data/bin/gh repo clone infodentalcz/infodental /data/workspace/infodental`
3. Přejdi do repo: `cd /data/workspace/infodental`
4. Nastav git identitu (jednou za session): `git config user.email "claude@anthropic.com" && git config user.name "Claude"`
5. Přečti si context z Slack threadu (`read_thread`) — zjisti na které větvi se pracuje
6. Checkout správné větve: `git fetch origin && git checkout <branch>`

## Klíčová pravidla
- **Vždy commitovat** po každé změně – kontejner se může restartovat a overlay filesystem se ztratí
- Klonovat do `/data/workspace/` (perzistentní disk), nikdy ne do `/tmp/` nebo kořene kontejneru
- **Nepořizovat nové větve ani PR** — vždy pokračovat na existující větvi/PR (zjistit z thread kontextu)
- GitHub token je dostupný jako `$GITHUB_TOKEN`, gh CLI je na `/data/bin/gh`

## Git / push
- `git remote set-url origin "https://x-access-token:${GITHUB_TOKEN}@github.com/infodentalcz/infodental.git"` – nutné před každým `git push` (token v URL), jinak push selže
- Push pomocí: `git push` (po nastavení upstream) nebo `git push -u origin <branch>`
- gh CLI: `GH_TOKEN=$GITHUB_TOKEN /data/bin/gh ...`
- Existující PR: zkontrolovat přes `GH_TOKEN=$GITHUB_TOKEN /data/bin/gh pr list --state open`

## Klíčové soubory
- `packages/frontend/src/components/charts/JobItemsStatsTable.tsx` – hlavní komponenta Statistik
- `packages/frontend/src/pages/stats.tsx` – stránka Statistik (pouze wrappuje JobItemsStatsTable)
- `packages/frontend/src/App.structure.tsx` – routing a struktura aplikace
- `packages/frontend/src/components/reports/worklogs.tsx` – komponenta Výkony (sdílená pro Laboratoř i Přehledy)
- `packages/frontend/src/components/job-stats-dashboard/components/TopTechniciansBarChartCard.tsx` – grafy techniků

## Provedené změny (větev feat/infd-137-stats-invoiced-filter, PR #14)
- **34e37f4**: layout hlavičky Statistik – view switcher vlevo, datum+hledání vpravo
- **3ea91f7**: sloupcové filtry (Jméno, Kód, Název) v tabulce Statistik
- **d8a9388**: fix TS build error (unused var), ikony filtrů → FilterOutlined
- **8d54fdb**: fix Obrat (ji.price→ji.priceTotal) a Výkon (kartézský součin v grafech)
- **8075c9c**: ReportWorklogs – přidán `mode?: "lab" | "overview"`, Přehledy/Výkony oddělen od Laboratoř/Výkony
- **62aa6ad**: dvoustupňové přepínání Statistik – entity (Položky/Technici/Lékaři/Ordinace) + detailLevel (Souhrn/Podrobný seznam), nové pohledy doctorDetailed, officeDetailed
- **13be504**: UX kultivace horní lišty – odstraněno `size="small"` ze Segmented, flex-col → flex-wrap (oba přepínače v jednom řádku)

## Architektura Statistik (JobItemsStatsTable)
- Stav: `entity` (items/technicians/doctors/offices) + `detailLevel` (summary/detailed)
- Derived: `viewMode` (7 hodnot: items, technicianDetailed, technicianSummary, doctorSummary, doctorDetailed, officeSummary, officeDetailed)
- Data: pouze vyfakturované zakázky (`js.invoiced = true`), řazené dle `inv.date`
- Výkon techniků: `SUM(wl.wage)` z `orm_work_logs` (zahrnuje kooperační podíly)
- Obrat: `SUM(ji.priceTotal)` = `price × amount` (ne jednotková cena `ji.price`)

## Technické poznatky
- Ant Design `Segmented` bez `size="small"` – výraznější padding, lépe čitelná aktivní volba
- `flex-wrap items-center gap-2` na wrapperu přepínačů = oba v jednom řádku, řízený wrap na mobilu
- Kartézský součin v grafech: `orm_work_logs` joinovaný přes `orm_job_items` bez správné podmínky → opravit přes `LEFT JOIN wl ON wl.jobItemId = ji.id AND wl.technicianUserId = u.id`
- `ReportWorklogs mode prop` – bezpečné oddělení Laboratoř/Přehledy bez duplikace kódu
- Sloupcové filtry v Ant Design Table: `filterDropdown` + `filterIcon` s modrou barvou při aktivním filtru
