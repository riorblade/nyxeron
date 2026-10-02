import { api, fmt, when, type Stats } from "../api";
import { Err, Kpi, Title, useLoad } from "../ui/kit";

export function Overview() {
  const { data: s, error } = useLoad(
    () => api<Stats>("GET", "/admin/stats"),
    [],
  );
  return (
    <>
      <Title sub="Players, economy and the services behind the game.">
        Overview
      </Title>
      <Err>{error}</Err>
      {s && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Kpi
            label="Players"
            value={fmt(s.users)}
            note={`${fmt(s.banned)} banned`}
          />
          <Kpi
            label="New"
            value={fmt(s.new24h)}
            note={`24h · ${fmt(s.new7d)} in 7 days`}
          />
          <Kpi label="Active 24h" value={fmt(s.active24h)} />
          <Kpi
            label="Live now"
            value={s.live ? fmt(s.live.rooms) : "—"}
            note={
              s.live
                ? `rooms · ${fmt(s.live.conns)} connections`
                : "relay unreachable"
            }
          />
          <Kpi
            label="Rent revenue"
            value={fmt(s.rent.week)}
            note={`last 7 days · ${fmt(s.rent.total)} all time`}
          />
          <Kpi label="Rented venues" value={fmt(s.rent.leases)} />
          <Kpi
            label="Coin in wallets"
            value={fmt(s.coin)}
            note="all guest wallets"
          />
          <Kpi label="Nights out" value={fmt(s.nights)} />
          <Kpi label="DJ gigs" value={fmt(s.gigs)} />
          <Kpi label="Career saves" value={fmt(s.saves)} />
          <Kpi
            label="Prices"
            value={s.quotes.source}
            note={`${s.quotes.tickers} tickers from Binance`}
          />
          <Kpi
            label="Last backup"
            value={
              s.lastBackup
                ? new Date(s.lastBackup * 1000).toLocaleDateString()
                : "none"
            }
            note={s.lastBackup ? when(s.lastBackup) : "daily, 7 kept"}
          />
          <Kpi
            label="Database"
            value={`${(s.dbBytes / 1048576).toFixed(1)} MB`}
          />
        </div>
      )}
    </>
  );
}
