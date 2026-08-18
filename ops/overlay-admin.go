package main

import (
	"crypto/subtle"
	"log"
	"os"
	"regexp"

	"github.com/b-open-io/bsv21-overlay/constants"
	"github.com/b-open-io/overlay/storage"
	"github.com/gofiber/fiber/v2"
)

// Whitelisting a token over HTTP, so a mint can index itself.
//
// WHY THIS EXISTS. The overlay indexes ONLY whitelisted tokens, and until now
// the only way to add one was `./config.run whitelist-add -token <id>` typed on
// this box. That is fine for a handful of tokens and impossible for $OpenBooks,
// which mints one token per WORD, from a browser, the moment somebody types it.
// A token the overlay has never heard of is indistinguishable from a token with
// no holders, so without this route every room on that board is a door locked
// for everybody.
//
// The whitelist is a Redis set and `RegisterTopics` re-reads it on a 30-second
// ticker (see cmd/server/server.go), so an add takes effect on the next tick
// with no restart. This route is exactly what the CLI does — one SAdd — with an
// authentication check in front of it.
//
// SECURITY, AND WHY THE GATE IS WHERE IT IS. The whitelist is what keeps a
// public /submit endpoint safe and keeps disk bounded, so opening it to the
// internet without a check would hand anybody the ability to make this box
// index arbitrary tokens forever. Hence:
//
//   - No token configured means the route IS NOT REGISTERED. Not "registered
//     and always refusing" — absent, so there is nothing to probe. An operator
//     who has not opted in is in exactly the state they were before.
//   - The comparison is constant-time. A byte-by-byte early return leaks the
//     secret to anybody willing to time it.
//   - The token id is validated STRICTLY before it reaches Redis, because this
//     value becomes both a set member and a topic name ("tm_" + id). An
//     unvalidated string here is stored, echoed and turned into an identifier.
const adminTokenEnv = "OVERLAY_ADMIN_TOKEN"

// A BSV-21 token id is its deploy outpoint: 64 lowercase hex, an underscore,
// and an output index. Anchored at both ends deliberately.
var tokenIDPattern = regexp.MustCompile(`^[0-9a-f]{64}_[0-9]{1,10}$`)

type whitelistRequest struct {
	Token string `json:"token"`
}

// RegisterAdminRoutes mounts the authenticated whitelist route, or mounts
// nothing at all when OVERLAY_ADMIN_TOKEN is unset.
func RegisterAdminRoutes(app *fiber.App, store *storage.EventDataStorage) {
	secret := os.Getenv(adminTokenEnv)
	if secret == "" {
		log.Printf("admin routes DISABLED (%s is not set)", adminTokenEnv)
		return
	}
	secretBytes := []byte(secret)

	authorised := func(c *fiber.Ctx) bool {
		supplied := c.Get("Authorization")
		const prefix = "Bearer "
		if len(supplied) > len(prefix) && supplied[:len(prefix)] == prefix {
			supplied = supplied[len(prefix):]
		}
		return subtle.ConstantTimeCompare([]byte(supplied), secretBytes) == 1
	}

	admin := app.Group("/api/v1/admin")

	// POST /api/v1/admin/whitelist  {"token":"<txid>_<vout>"}
	//
	// Idempotent: SAdd on a member that is already present is a no-op, so a
	// client that retries after a lost response does no harm. That matters —
	// this is called from a mint flow, where the alternative to retrying is a
	// token that is on chain and permanently unindexed.
	admin.Post("/whitelist", func(c *fiber.Ctx) error {
		if !authorised(c) {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "unauthorized"})
		}

		var body whitelistRequest
		if err := c.BodyParser(&body); err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid json body"})
		}
		if !tokenIDPattern.MatchString(body.Token) {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
				"error": "token must be <64-hex-txid>_<vout>",
			})
		}

		queueStore := store.GetQueueStorage()
		if err := queueStore.SAdd(c.Context(), constants.KeyWhitelist, body.Token); err != nil {
			log.Printf("whitelist-add %s failed: %v", body.Token, err)
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
				"error": "could not write to the whitelist",
			})
		}
		log.Printf("whitelisted %s via admin route", body.Token)

		// The caller is told the token is not indexed YET, on purpose. The
		// failure this indexer is most likely to hand a client is not an error
		// — it is an empty answer that looks exactly like a correct one. A
		// caller that reads holders immediately after this returns will get
		// nothing and may well believe it.
		return c.JSON(fiber.Map{
			"token":            body.Token,
			"whitelisted":      true,
			"indexing":         "pending",
			"readyAfterSeconds": 30,
			"note":             "topic managers refresh on a 30s ticker; an immediate read returns an empty answer that is NOT authoritative",
		})
	})

	// GET /api/v1/admin/whitelist — what this overlay is actually tracking.
	//
	// Included because "did my add take" is otherwise only answerable by
	// SSHing to this box, and the whole point of the POST is to remove that
	// requirement from the mint path.
	admin.Get("/whitelist", func(c *fiber.Ctx) error {
		if !authorised(c) {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "unauthorized"})
		}
		tokens, err := store.GetQueueStorage().SMembers(c.Context(), constants.KeyWhitelist)
		if err != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
				"error": "could not read the whitelist",
			})
		}
		return c.JSON(fiber.Map{"tokens": tokens, "count": len(tokens)})
	})

	log.Printf("admin routes enabled at /api/v1/admin/whitelist")
}
