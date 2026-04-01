import { convexAuth } from "@convex-dev/auth/server"
import { Password } from "@convex-dev/auth/providers/Password"

export const { auth, signIn, signOut, store } = convexAuth({
    providers: [
        Password({
            profile(params) {
                if (params.flow === "signUp") {
                    throw new Error("Signup is disabled")
                }

                return {
                    email: params.email as string,
                }
            },
        }),
    ],
})
