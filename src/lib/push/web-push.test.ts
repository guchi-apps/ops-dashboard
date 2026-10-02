import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { listSubscriptions, removeSubscriptionOf, saveSubscription } from "@/lib/push/web-push"

function withTempFile<T>(run: () => Promise<T>): Promise<T> {
    const dir = mkdtempSync(path.join(tmpdir(), "push-subs-"))
    const previous = process.env.PUSH_SUBSCRIPTIONS_PATH
    process.env.PUSH_SUBSCRIPTIONS_PATH = path.join(dir, "subs.json")
    return run().finally(() => {
        if (previous === undefined) delete process.env.PUSH_SUBSCRIPTIONS_PATH
        else process.env.PUSH_SUBSCRIPTIONS_PATH = previous
        rmSync(dir, { recursive: true, force: true })
    })
}

const subscription = (endpoint: string) => ({ endpoint, keys: { p256dh: "p", auth: "a" } })

describe("購読の登録", () => {
    it("起動のたびの登録し直しで、端末のオフ設定と利用者が消えない", () =>
        withTempFile(async () => {
            await saveSubscription(subscription("https://push.example/1"), { email: "a@example.com", hostAlerts: false })
            await saveSubscription(subscription("https://push.example/1"), { email: "a@example.com" })

            const [saved] = await listSubscriptions()
            assert.equal(saved.email, "a@example.com")
            assert.equal(saved.hostAlerts, false)
        }))

    it("利用者が未記録の既存購読は、登録し直しで本人に紐づく", () =>
        withTempFile(async () => {
            await saveSubscription(subscription("https://push.example/1"))
            assert.equal((await listSubscriptions())[0].email, undefined)

            await saveSubscription(subscription("https://push.example/1"), { email: "a@example.com" })
            assert.equal((await listSubscriptions())[0].email, "a@example.com")
        }))

    it("他の利用者の端末は解除できず、本人と持ち主未記録の端末は解除できる", () =>
        withTempFile(async () => {
            await saveSubscription(subscription("https://push.example/1"), { email: "a@example.com" })
            await saveSubscription(subscription("https://push.example/2"))

            assert.equal(await removeSubscriptionOf("https://push.example/1", "b@example.com"), "forbidden")
            assert.equal(await removeSubscriptionOf("https://push.example/9", "b@example.com"), "missing")
            assert.equal(await removeSubscriptionOf("https://push.example/2", "b@example.com"), "removed")
            assert.equal(await removeSubscriptionOf("https://push.example/1", "a@example.com"), "removed")
            assert.equal((await listSubscriptions()).length, 0)
        }))
})
