import { Hono } from "hono";
import { accounts, addAccount, getAccountByEmail, removeAccount } from "../services/accountManager.ts";
import { saveCookies } from "../services/auth.ts";
import { configureAccount } from "../services/deepseekModels.ts";
import { loginFresh } from "../services/loginService.ts";

export const accountsRouter = new Hono();

accountsRouter.get("/", (c) =>
  c.json({ accounts: accounts.map((a) => ({ email: a.email, expiresAt: a.state?.expiresAt ?? null })) }),
);

accountsRouter.get("/:email/login", async (c) => {
  try {
    const email = c.req.param("email");

    // Check if account exists
    const account = getAccountByEmail(email);
    if (!account) {
      return c.json({ error: "Account not found" }, 404);
    }

    // If we have a password, trigger login using loginFresh
    if (account.password) {
      const result = await loginFresh(email, account.password);
      if (result) {
        return c.json({
          success: true,
          email: email,
          loggedIn: true,
        });
      } else {
        return c.json(
          {
            success: false,
            error: "Login failed",
            email: email,
          },
          400,
        );
      }
    } else {
      // If no password, return that login is not possible via this endpoint
      return c.json(
        {
          success: false,
          error: "No password available for account - interactive login required",
          email: email,
        },
        400,
      );
    }
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

accountsRouter.delete("/:email", async (c) => {
  try {
    const email = c.req.param("email");

    // Check if account exists
    const account = getAccountByEmail(email);
    if (!account) {
      return c.json({ error: "Account not found" }, 404);
    }

    // Remove the account using the account manager
    await removeAccount(email);

    return c.json({
      success: true,
      email: email,
    });
  } catch (error: any) {
    if (error.message.includes("not found")) {
      return c.json({ error: "Account not found" }, 404);
    }
    return c.json({ error: error.message }, 500);
  }
});

accountsRouter.post("/", async (c) => {
  try {
    const body = await c.req.json();
    const { email, password } = body;

    if (!email || !password) {
      return c.json({ error: "Email and password are required" }, 400);
    }

    // Add the account using the account manager
    const result = await addAccount(email, password);

    if (result.loginSucceeded) {
      // Configure the account after adding it
      await configureAccount(email);
      return c.json({
        success: true,
        email: email,
      });
    } else {
      return c.json(
        {
          error: result.loginError || "Login failed",
        },
        400,
      );
    }
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

accountsRouter.post("/:email/token", async (c) => {
  try {
    const email = c.req.param("email");
    const account = getAccountByEmail(email);
    if (!account) return c.json({ error: "Account not found" }, 404);

    const body = await c.req.json();
    const { token, refreshToken } = body;
    if (!token || typeof token !== "string") {
      return c.json({ error: "token is required" }, 400);
    }

    await saveCookies(email, token, refreshToken || null);
    await configureAccount(email);
    return c.json({ success: true, email, expiresAt: account.state?.expiresAt ?? null });
  } catch (error) {
    return c.json({ error: (error as Error).message }, 500);
  }
});
