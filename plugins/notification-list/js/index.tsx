import { Design } from "@revenge-mod/discord/design";
import { Stores } from "@revenge-mod/discord/flux";
import { lookupModule } from "@revenge-mod/modules/finders";
import { withProps } from "@revenge-mod/modules/finders/filters";
import { useEffect, useState } from "react";

const { TableRowGroup, TableRow } = Design;

function findModuleByProp(prop: string): any {
    const result = lookupModule(withProps(prop));
    return Array.isArray(result) && result.length ? result[0] : undefined;
}

interface Notif {
    channelId: string;
    guildId: string | null;
    guildName: string;
    title: string;
    mentionCount: number;
    messageId?: string;
}

interface Group {
    key: string;
    name: string;
    items: Notif[];
}

function openChannel(notif: Notif) {
    // 1. transitionToGuild — the notification-center navigation (confirmed in community plugins)
    const tg = findModuleByProp("transitionToGuild");
    if (tg?.transitionToGuild) {
        tg.transitionToGuild(notif.guildId ?? "@me", notif.channelId, notif.messageId);
        return;
    }
    // 2. jumpToMessage
    const jm = findModuleByProp("jumpToMessage");
    if (jm?.jumpToMessage) {
        jm.jumpToMessage({ channelId: notif.channelId, messageId: notif.messageId, flash: true });
        return;
    }
    // 3. openDeeplink
    const dl = findModuleByProp("openDeeplink");
    if (dl?.openDeeplink) {
        const gid = notif.guildId ?? "@me";
        const url = notif.messageId
            ? `https://discord.com/channels/${gid}/${notif.channelId}/${notif.messageId}`
            : `https://discord.com/channels/${gid}/${notif.channelId}`;
        dl.openDeeplink(url);
    }
}

function markChannelRead(channelId: string, messageId?: string) {
    const mod = findModuleByProp("dispatch");
    if (!mod?.dispatch) return;
    mod.dispatch({
        type: "BULK_ACK",
        context: "APP",
        channels: [{ channelId, messageId, readStateType: 0 }]
    });
}

function gather(): Notif[] {
    const rs = (Stores as any).ReadStateStore;
    const cs = (Stores as any).ChannelStore;
    const gs = (Stores as any).GuildStore;
    const gcs = (Stores as any).GuildChannelStore;
    if (!rs || !cs) return [];

    const out: Notif[] = [];
    const seen = new Set<string>();

    const push = (ch: any) => {
        if (!ch || !ch.id || seen.has(ch.id)) return;
        seen.add(ch.id);
        const isDm = ch.type === 1 || ch.type === 3;
        const guildId: string | null = isDm ? null : (ch.guild_id ?? null);
        const guild = guildId && gs?.getGuild ? gs.getGuild(guildId) : null;
        const lastId = ch.lastMessageId ?? rs.lastMessageId?.(ch.id);
        const messageId = (rs.getOldestUnreadMessageId?.(ch.id) ?? lastId) || undefined;
        out.push({
            channelId: ch.id,
            guildId,
            guildName: isDm ? "Direct Messages" : (guild?.name ?? "Server"),
            title: isDm ? (ch.name || "DM") : "#" + (ch.name || ch.id),
            mentionCount: rs.getMentionCount?.(ch.id) ?? 0,
            messageId
        });
    };

    if (gs?.getGuilds && gcs?.getChannels) {
        for (const gid of Object.keys(gs.getGuilds())) {
            const chans = gcs.getChannels(gid) ?? {};
            const selectable = chans.SELECTABLE ?? [];
            for (const e of selectable) {
                const ch = e?.channel ?? e;
                if (ch?.id && rs.hasUnread?.(ch.id)) push(ch);
            }
        }
    }

    if (cs.getSortedPrivateChannels) {
        for (const ch of cs.getSortedPrivateChannels()) {
            if (rs.hasUnread?.(ch.id)) push(ch);
        }
    }

    return out.sort(
        (a, b) => (rs.lastMessageTimestamp?.(b.channelId) ?? 0) - (rs.lastMessageTimestamp?.(a.channelId) ?? 0)
    );
}

function groupItems(items: Notif[]): Group[] {
    const groups: Group[] = [];
    const index = new Map<string, number>();
    for (const item of items) {
        const key = item.guildId ?? "__dm__";
        let gi = index.get(key);
        if (gi === undefined) {
            gi = groups.length;
            index.set(key, gi);
            groups.push({ key, name: item.guildName, items: [] });
        }
        groups[gi].items.push(item);
    }
    return groups;
}

export default plugin({
    start() {},

    stop() {},

    SettingsComponent() {
        const [items, setItems] = useState<Notif[]>([]);
        const [tick, setTick] = useState(0);

        useEffect(() => {
            setItems(gather());
        }, [tick]);

        const groups = groupItems(items);

        const markAll = () => {
            for (const item of items) markChannelRead(item.channelId, item.messageId);
            setItems([]);
        };

        return (
            <>
                {groups.length === 0 && (
                    <TableRowGroup title="Unread notifications">
                        <TableRow label="You're all caught up 🎉" />
                    </TableRowGroup>
                )}
                {groups.map(group => (
                    <TableRowGroup key={group.key} title={group.name}>
                        {group.items.map(item => (
                            <TableRow
                                key={item.channelId}
                                label={item.mentionCount > 0 ? `${item.title}  (@${item.mentionCount})` : item.title}
                                onPress={() => openChannel(item)}
                            />
                        ))}
                    </TableRowGroup>
                ))}
                <TableRowGroup title="Actions">
                    {items.length > 0 && (
                        <TableRow label="Mark all read" onPress={markAll} />
                    )}
                    <TableRow label="Refresh" onPress={() => setTick(t => t + 1)} />
                </TableRowGroup>
            </>
        );
    }
});
