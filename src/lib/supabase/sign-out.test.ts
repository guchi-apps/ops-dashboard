import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { signOutLocally } from "@/lib/supabase/sign-out"

describe("signOutLocally", () => {
    it("scope: local を渡してこのアプリのセッションだけを破棄する（既定の global にしない）", async () => {
        const calls: unknown[][] = []
        const supabase = {
            auth: {
                async signOut(...args: unknown[]) {
                    calls.push(args)
                    return { error: null }
                },
            },
        }

        await signOutLocally(supabase)

        assert.deepEqual(calls, [[{ scope: "local" }]])
    })

    it("signOut が失敗したら呼び出し元へ伝える", async () => {
        const supabase = {
            auth: {
                async signOut(): Promise<never> {
                    throw new Error("network")
                },
            },
        }

        await assert.rejects(() => signOutLocally(supabase), /network/)
    })
})
