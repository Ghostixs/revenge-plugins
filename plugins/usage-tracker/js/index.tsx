import { useEffect, useState } from "react";
import { React, ReactNative } from "@revenge-mod/react";
import { afterJSX } from "@revenge-mod/react/jsx-runtime";
import { lookupModule } from "@revenge-mod/modules/finders";
import { withName } from "@revenge-mod/modules/finders/filters";
import { Design } from "@revenge-mod/discord/design";

const { TableRowGroup, TableRow, TextInput, Button, Text } = Design;
const { View, StyleSheet } = ReactNative;

interface Settings {
    deepseekKey: string;
    codexUrl: string;
}

interface UsageData {
    dsBalance: string | null;
    dsCurrency: string;
    dsError: string | null;
    codexLeft: number | null;
    codexStale: boolean;
    codexError: string | null;
    updatedAt: number;
}

// Captured in start(); a no-op stand-in keeps hooks safe before then.
let jsonStorage: any = { use: () => ({}), set: () => {} };

const REFRESH_MS = 15 * 60 * 1000; // 15 min

async function fetchDeepSeek(key: string): Promise<{ balance: string; currency: string }> {
    const res = await fetch("https://api.deepseek.com/user/balance", {
        method: "GET",
        headers: {
            Accept: "application/json",
            Authorization: "Bearer " + key,
        },
    });
    if (!res.ok) throw new Error("DeepSeek HTTP " + res.status);
    const data: any = await res.json();
    const infos = data?.balance_infos ?? [];
    if (!infos.length) throw new Error("No balance info returned");
    return { balance: String(infos[0].total_balance), currency: String(infos[0].currency) };
}

async function fetchCodex(url: string): Promise<{ leftPct: number; stale: boolean }> {
    const res = await fetch(url);
    if (!res.ok) throw new Error("Codex feed HTTP " + res.status);
    const data: any = await res.json();
    const codex = data?.codex ?? {};
    if (codex.overall_used_pct === undefined) throw new Error("Feed has no codex.overall_used_pct");
    return { leftPct: Math.round(100 - Number(codex.overall_used_pct)), stale: !!codex.stale };
}

function useUsage(tick = 0): UsageData {
    const settings = jsonStorage.use() as Settings;
    const dsKey = (settings?.deepseekKey ?? "").trim();
    const codexUrl = (settings?.codexUrl ?? "").trim();

    const [data, setData] = useState<UsageData>({
        dsBalance: null,
        dsCurrency: "USD",
        dsError: null,
        codexLeft: null,
        codexStale: false,
        codexError: null,
        updatedAt: 0,
    });

    useEffect(() => {
        let alive = true;
        const load = async () => {
            const next: UsageData = {
                dsBalance: null,
                dsCurrency: "USD",
                dsError: null,
                codexLeft: null,
                codexStale: false,
                codexError: null,
                updatedAt: Date.now(),
            };
            if (dsKey) {
                try {
                    const r = await fetchDeepSeek(dsKey);
                    next.dsBalance = r.balance;
                    next.dsCurrency = r.currency;
                } catch (e) {
                    next.dsError = e instanceof Error ? e.message : String(e);
                }
            }
            if (codexUrl) {
                try {
                    const r = await fetchCodex(codexUrl);
                    next.codexLeft = r.leftPct;
                    next.codexStale = r.stale;
                } catch (e) {
                    next.codexError = e instanceof Error ? e.message : String(e);
                }
            }
            if (alive) setData(next);
        };
        load();
        const t = setInterval(load, REFRESH_MS);
        return () => {
            alive = false;
            clearInterval(t);
        };
    }, [dsKey, codexUrl, tick]);

    return data;
}

function UsageBar() {
    const d = useUsage();
    const ds = d.dsBalance ? "$" + d.dsBalance : d.dsError ? "DS err" : "DS —";
    const cx = d.codexLeft !== null ? "Codex " + d.codexLeft + "% left" : d.codexError ? "Codex err" : "Codex —";
    return (
        <View style={styles.bar}>
            <Text style={styles.txt}>{ds}</Text>
            <Text style={styles.sep}>·</Text>
            <Text style={styles.txt}>{cx}</Text>
        </View>
    );
}

const styles = StyleSheet.create({
    bar: {
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        paddingVertical: 5,
        paddingHorizontal: 10,
        backgroundColor: "rgba(0,0,0,0.35)",
    },
    txt: {
        fontSize: 12,
        fontWeight: "600",
        color: "#e8e3f0",
        fontVariant: ["tabular-nums"],
    },
    sep: {
        fontSize: 12,
        color: "#8a7f9c",
        marginHorizontal: 8,
    },
    inputWrap: {
        paddingHorizontal: 16,
        paddingTop: 8,
        paddingBottom: 16,
    },
    inputGap: {
        height: 12,
    },
});

export default plugin<{ jsonStorage: Settings }>({
    jsonStorage: {
        load: true,
        default: { deepseekKey: "", codexUrl: "https://ghostixs.github.io/revenge-plugins/codex.json" },
    },

    start({ cleanup, jsonStorage: js, logger }) {
        jsonStorage = js;
        logger.log("[usage-tracker] started");

        // Best-effort: pin the readout at the top of the channel list.
        // Discord mobile reuses the same component names as the Vendetta era;
        // we probe several, inject into whichever resolves, and no-op silently otherwise.
        const candidates = [
            "ConnectedPrivateChannels",
            "ConnectedGuildChannels",
            "GuildChannels",
            "ChannelList",
            "ChatList",
        ];
        for (const name of candidates) {
            try {
                const found = lookupModule(withName(name));
                if (!found || !found[0]) continue;
                const mod: any = found[0];
                const Comp = mod.default ?? mod;
                if (typeof Comp !== "function" && typeof Comp !== "object") continue;
                cleanup(
                    afterJSX(Comp, (el: any) => {
                        if (!el || !el.props) return el;
                        const prev = el.props.children;
                        const arr = Array.isArray(prev) ? prev : prev ? [prev] : [];
                        arr.unshift(<UsageBar key="usage-tracker-bar" />);
                        el.props.children = arr;
                        return el;
                    }),
                );
                logger.log("[usage-tracker] pinned readout into " + name);
            } catch (e) {
                logger.warn("[usage-tracker] skip " + name + ": " + String(e));
            }
        }
    },

    SettingsComponent({ api }) {
        const settings = api.jsonStorage.use() as Settings;
        const [tick, setTick] = useState(0);
        const d = useUsage(tick);
        const dsKey = settings?.deepseekKey ?? "";
        const codexUrl = settings?.codexUrl ?? "";

        return (
            <>
                <TableRowGroup title="Live usage">
                    <TableRow
                        label="DeepSeek"
                        subLabel={
                            d.dsBalance
                                ? "Balance as of your last refresh"
                                : d.dsError
                                  ? "Error: " + d.dsError
                                  : "Add your API key below"
                        }
                        trailing={<Text>{d.dsBalance ? "$" + d.dsBalance + " " + d.dsCurrency : "—"}</Text>}
                    />
                    <TableRow
                        label="Codex"
                        subLabel={
                            d.codexLeft !== null
                                ? d.codexStale
                                    ? "Left (last known, may be stale)"
                                    : "Weekly limit left"
                                : d.codexError
                                  ? "Error: " + d.codexError
                                  : "Add your feed URL below"
                        }
                        trailing={<Text>{d.codexLeft !== null ? d.codexLeft + "%" : "—"}</Text>}
                    />
                </TableRowGroup>

                <TableRowGroup title="Sources">
                    <TableRow
                        label="Refresh now"
                        trailing={
                            <Button
                                text="Refresh"
                                onPress={() => setTick((t) => t + 1)}
                            />
                        }
                    />
                </TableRowGroup>

                <View style={styles.inputWrap}>
                    <TextInput
                        label="DeepSeek API key"
                        value={dsKey}
                        onChange={(v: string) => api.jsonStorage.set({ deepseekKey: v })}
                        placeholder="sk-..."
                        size="md"
                    />
                    <View style={styles.inputGap} />
                    <TextInput
                        label="Codex feed URL"
                        value={codexUrl}
                        onChange={(v: string) => api.jsonStorage.set({ codexUrl: v })}
                        placeholder="https://…/codex.json"
                        size="md"
                    />
                </View>

                <TableRowGroup title="Pinned readout">
                    <TableRow
                        label="Where it shows"
                        subLabel="A slim bar at the very top of your channel list, near the server name. Updates every 15 minutes. If it does not appear, tell Nova and the anchor component name will be adjusted."
                    />
                </TableRowGroup>
            </>
        );
    },
});
