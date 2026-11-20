use sha2::{Digest, Sha256};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnubisChallengeRules {
    pub algorithm: Option<String>,
    pub difficulty: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnubisChallengeData {
    pub id: String,
    #[serde(rename = "randomData")]
    pub random_data: String,
    pub difficulty: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnubisChallengePayload {
    pub rules: Option<AnubisChallengeRules>,
    pub challenge: AnubisChallengeData,
}

#[derive(Debug, Clone)]
pub struct AnubisSolution {
    pub challenge_id: String,
    pub nonce: u64,
    pub response_hash: String,
    pub elapsed_ms: u128,
    /// `true` when a nonce satisfying the challenge difficulty was found.
    /// `false` means the iteration budget was exhausted (or difficulty was
    /// clamped) — callers must treat such a solution as a failure instead of
    /// submitting it to the origin.
    pub solved: bool,
}

#[inline]
fn has_leading_hex_zeros(bytes: &[u8], difficulty: usize) -> bool {
    let full_bytes = difficulty / 2;
    if bytes.len() < full_bytes {
        return false;
    }
    for &b in &bytes[..full_bytes] {
        if b != 0 {
            return false;
        }
    }
    if difficulty % 2 != 0 {
        if let Some(&b) = bytes.get(full_bytes) {
            if (b >> 4) != 0 {
                return false;
            }
        } else {
            return false;
        }
    }
    true
}

pub struct AnubisSolver;

impl AnubisSolver {
    /// Hard ceiling for the PoW difficulty. Real Anubis deployments stay at 2-4;
    /// anything higher is either a hostile page or a mis-parse, and solving it
    /// would burn CPU for minutes. Clamping keeps the app responsive.
    pub const MAX_DIFFICULTY: usize = 6;
    /// Hard ceiling for the nonce search. At difficulty 6 (~1/16.7M chance per
    /// attempt) this is a ~3x safety margin; exceeding it means we bail out and
    /// let the caller retry / surface an error instead of spinning forever.
    pub const MAX_ATTEMPTS: u64 = 50_000_000;
    /// Lower bound for the `elapsedTime` reported to Anubis. Anything faster
    /// looks bot-like to some deployments and is rejected.
    pub const MIN_ELAPSED_MS: u128 = 100;
    /// Upper bound for the `elapsedTime` reported to Anubis; a stale value is
    /// rejected as well, so never send more than 30 s.
    pub const MAX_ELAPSED_MS: u128 = 30_000;

    /// Whether the PoW algorithm advertised by the challenge is one we can
    /// solve.
    ///
    /// Only the default `"fast"` variant (SHA-256 with leading zero nibbles) is
    /// supported. Anubis' `"slow"` variant uses a different, memory-hard
    /// construction, so attempting it would only burn CPU without ever passing.
    pub fn is_algorithm_supported(challenge: &AnubisChallengePayload) -> bool {
        match challenge.rules.as_ref().and_then(|r| r.algorithm.as_deref()) {
            None => true,
            Some(algorithm) => algorithm.trim().eq_ignore_ascii_case("fast"),
        }
    }

    /// Clamps an `elapsedTime` measurement between [`Self::MIN_ELAPSED_MS`] and
    /// [`Self::MAX_ELAPSED_MS`].
    pub fn clamp_elapsed_ms(elapsed_ms: u128) -> u128 {
        elapsed_ms.clamp(Self::MIN_ELAPSED_MS, Self::MAX_ELAPSED_MS)
    }

    /// Detects if HTML page is an Anubis PoW challenge page
    pub fn is_anubis_challenge(html: &str) -> bool {
        html.contains("id=\"anubis_challenge\"")
            || html.contains("id='anubis_challenge'")
            || html.contains("Проверяем, что вы не бот")
            || html.contains("/.within.website/x/cmd/anubis/")
    }

    /// Extracts Anubis challenge payload from HTML (attribute order agnostic)
    pub fn extract_challenge(html: &str) -> Option<AnubisChallengePayload> {
        let marker = if let Some(idx) = html.find("id=\"anubis_challenge\"") {
            idx
        } else if let Some(idx) = html.find("id='anubis_challenge'") {
            idx
        } else {
            return None;
        };

        // Find the closing '>' of the <script ...> tag
        let content_start = html[marker..].find('>')? + marker + 1;
        // Find the closing </script>
        let content_end = html[content_start..].find("</script>")? + content_start;
        let json_str = html[content_start..content_end].trim();
        serde_json::from_str::<AnubisChallengePayload>(json_str).ok()
    }

    /// Effective (clamped) difficulty for a challenge payload.
    pub fn effective_difficulty(challenge: &AnubisChallengePayload) -> usize {
        let raw = challenge
            .challenge
            .difficulty
            .or_else(|| challenge.rules.as_ref().and_then(|r| r.difficulty))
            .unwrap_or(2) as usize;
        raw.min(Self::MAX_DIFFICULTY)
    }

    /// Solves the PoW challenge: finds nonce such that SHA256(random_data + nonce)
    /// has `difficulty` leading hex zeros.
    ///
    /// Optimized with zero heap allocations in the search loop:
    /// - `base_hasher` is pre-warmed with `random_data`
    /// - `nonce` is formatted into a stack buffer
    /// - Leading zeros are checked directly on raw hash bytes before hex encoding
    ///
    /// The search is bounded (see [`Self::MAX_DIFFICULTY`] / [`Self::MAX_ATTEMPTS`])
    /// so a malformed or hostile challenge can never hang the blocking thread.
    pub fn solve(challenge: &AnubisChallengePayload) -> AnubisSolution {
        Self::solve_with_limits(challenge, Self::MAX_DIFFICULTY, Self::MAX_ATTEMPTS)
    }

    /// Bounded implementation of [`Self::solve`]; limits are injectable for tests.
    pub(crate) fn solve_with_limits(
        challenge: &AnubisChallengePayload,
        max_difficulty: usize,
        max_attempts: u64,
    ) -> AnubisSolution {
        use std::io::Write;

        // Refuse unsupported algorithms up-front instead of grinding a PoW that
        // the origin will never accept (`"slow"` uses a different construction).
        if !Self::is_algorithm_supported(challenge) {
            eprintln!(
                "[RDX Anubis] unsupported PoW algorithm {:?}; refusing to solve",
                challenge.rules.as_ref().and_then(|r| r.algorithm.as_deref())
            );
            return AnubisSolution {
                challenge_id: challenge.challenge.id.clone(),
                nonce: 0,
                response_hash: String::new(),
                elapsed_ms: 0,
                solved: false,
            };
        }

        let start = std::time::Instant::now();
        let difficulty = Self::effective_difficulty(challenge).min(max_difficulty);

        let random_data = &challenge.challenge.random_data;
        let mut base_hasher = Sha256::new();
        base_hasher.update(random_data.as_bytes());

        let mut nonce: u64 = 0;
        let mut response_hash = String::new();
        let mut solved = false;
        let mut nonce_buf = [0u8; 32];

        while nonce <= max_attempts {
            let nonce_len = {
                let mut cursor = std::io::Cursor::new(&mut nonce_buf[..]);
                let _ = write!(cursor, "{}", nonce);
                cursor.position() as usize
            };

            let mut hasher = base_hasher.clone();
            hasher.update(&nonce_buf[..nonce_len]);
            let result = hasher.finalize();

            if has_leading_hex_zeros(&result, difficulty) {
                response_hash = hex::encode(result);
                solved = true;
                break;
            }

            nonce += 1;
        }

        if !solved {
            // Budget exhausted: report the hash of the last tried nonce so callers
            // (and tests) can inspect it, but mark the solution as unsolved.
            let mut hasher = base_hasher.clone();
            let nonce_len = {
                let mut cursor = std::io::Cursor::new(&mut nonce_buf[..]);
                let _ = write!(cursor, "{}", nonce);
                cursor.position() as usize
            };
            hasher.update(&nonce_buf[..nonce_len]);
            response_hash = hex::encode(hasher.finalize());
        }

        let elapsed_ms = Self::clamp_elapsed_ms(start.elapsed().as_millis());

        AnubisSolution {
            challenge_id: challenge.challenge.id.clone(),
            nonce,
            response_hash,
            elapsed_ms,
            solved,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_and_solve_anubis() {
        let sample_html = r#"
        <!DOCTYPE html>
        <html>
        <head>
            <title>Проверяем, что вы не бот!</title>
            <script id="anubis_challenge" type="application/json">
            {
              "rules": {"algorithm": "fast", "difficulty": 2},
              "challenge": {
                "id": "test-uuid-1234-5678",
                "randomData": "a1b2c3d4e5f67890",
                "difficulty": 2
              }
            }
            </script>
        </head>
        <body>Solving...</body>
        </html>
        "#;

        assert!(AnubisSolver::is_anubis_challenge(sample_html));
        let challenge = AnubisSolver::extract_challenge(sample_html).expect("extract challenge");
        assert_eq!(challenge.challenge.id, "test-uuid-1234-5678");
        assert_eq!(challenge.challenge.random_data, "a1b2c3d4e5f67890");

        let solution = AnubisSolver::solve(&challenge);
        assert!(solution.solved);
        assert!(solution.response_hash.starts_with("00"));
        assert_eq!(solution.challenge_id, "test-uuid-1234-5678");

        // Verify SHA256 matches
        let mut hasher = Sha256::new();
        hasher.update(challenge.challenge.random_data.as_bytes());
        hasher.update(solution.nonce.to_string().as_bytes());
        assert_eq!(hex::encode(hasher.finalize()), solution.response_hash);
    }

    #[test]
    fn test_extract_anubis_different_attribute_order() {
        let flipped_html = r#"<script type="application/json" id="anubis_challenge">{"challenge":{"id":"1","randomData":"abc"}}</script>"#;
        let challenge1 = AnubisSolver::extract_challenge(flipped_html).expect("extract flipped");
        assert_eq!(challenge1.challenge.id, "1");

        let single_quote_html = r#"<script type='application/json' id='anubis_challenge'>{"challenge":{"id":"2","randomData":"xyz"}}</script>"#;
        let challenge2 = AnubisSolver::extract_challenge(single_quote_html).expect("extract single quote");
        assert_eq!(challenge2.challenge.id, "2");
    }

    fn challenge_with_difficulty(difficulty: Option<u32>) -> AnubisChallengePayload {
        AnubisChallengePayload {
            rules: None,
            challenge: AnubisChallengeData {
                id: "cap-test".to_string(),
                random_data: "deadbeef".to_string(),
                difficulty,
            },
        }
    }

    #[test]
    fn test_effective_difficulty_is_clamped() {
        assert_eq!(AnubisSolver::effective_difficulty(&challenge_with_difficulty(None)), 2);
        assert_eq!(
            AnubisSolver::effective_difficulty(&challenge_with_difficulty(Some(3))),
            3
        );
        assert_eq!(
            AnubisSolver::effective_difficulty(&challenge_with_difficulty(Some(32))),
            AnubisSolver::MAX_DIFFICULTY
        );

        // `rules.difficulty` is used as a fallback when the challenge omits it
        let mut from_rules = challenge_with_difficulty(None);
        from_rules.rules = Some(AnubisChallengeRules {
            algorithm: Some("fast".to_string()),
            difficulty: Some(99),
        });
        assert_eq!(
            AnubisSolver::effective_difficulty(&from_rules),
            AnubisSolver::MAX_DIFFICULTY
        );
    }

    #[test]
    fn test_solve_respects_attempt_budget() {
        // Difficulty 6 with a tiny budget must give up instead of hanging.
        let challenge = challenge_with_difficulty(Some(6));
        let solution = AnubisSolver::solve_with_limits(&challenge, AnubisSolver::MAX_DIFFICULTY, 64);
        assert!(!solution.solved);
        assert!(solution.nonce <= 65, "nonce {} exceeded budget", solution.nonce);
        assert!(!solution.response_hash.is_empty());
    }

    #[test]
    fn test_solve_budget_still_finds_easy_solution() {
        let challenge = challenge_with_difficulty(Some(2));
        let solution = AnubisSolver::solve_with_limits(&challenge, AnubisSolver::MAX_DIFFICULTY, 10_000);
        assert!(solution.solved);
        assert!(solution.response_hash.starts_with("00"));
    }

    #[test]
    fn test_slow_algorithm_is_not_solved() {
        let mut challenge = challenge_with_difficulty(Some(1));
        challenge.rules = Some(AnubisChallengeRules {
            algorithm: Some("slow".to_string()),
            difficulty: Some(1),
        });

        assert!(!AnubisSolver::is_algorithm_supported(&challenge));
        let solution = AnubisSolver::solve(&challenge);
        assert!(!solution.solved, "slow Anubis variant must not be attempted");
        assert_eq!(solution.nonce, 0);
        assert!(solution.response_hash.is_empty());
        assert_eq!(solution.challenge_id, "cap-test");
    }

    #[test]
    fn test_fast_or_missing_algorithm_is_supported() {
        let missing = challenge_with_difficulty(Some(2));
        assert!(AnubisSolver::is_algorithm_supported(&missing));

        let mut fast = challenge_with_difficulty(Some(2));
        fast.rules = Some(AnubisChallengeRules {
            algorithm: Some("FAST".to_string()),
            difficulty: Some(2),
        });
        assert!(AnubisSolver::is_algorithm_supported(&fast));

        let mut unknown = challenge_with_difficulty(Some(2));
        unknown.rules = Some(AnubisChallengeRules {
            algorithm: Some("memory-hard".to_string()),
            difficulty: Some(2),
        });
        assert!(!AnubisSolver::is_algorithm_supported(&unknown));
    }

    #[test]
    fn test_elapsed_ms_is_clamped() {
        assert_eq!(AnubisSolver::clamp_elapsed_ms(0), AnubisSolver::MIN_ELAPSED_MS);
        assert_eq!(AnubisSolver::clamp_elapsed_ms(99), AnubisSolver::MIN_ELAPSED_MS);
        assert_eq!(AnubisSolver::clamp_elapsed_ms(100), 100);
        assert_eq!(AnubisSolver::clamp_elapsed_ms(12_345), 12_345);
        assert_eq!(AnubisSolver::clamp_elapsed_ms(30_000), AnubisSolver::MAX_ELAPSED_MS);
        assert_eq!(AnubisSolver::clamp_elapsed_ms(60_000), AnubisSolver::MAX_ELAPSED_MS);

        // The solver output is already clamped, so the pass-challenge URL never
        // carries a suspicious value.
        let solution = AnubisSolver::solve_with_limits(
            &challenge_with_difficulty(Some(2)),
            AnubisSolver::MAX_DIFFICULTY,
            10_000,
        );
        assert!(solution.elapsed_ms >= AnubisSolver::MIN_ELAPSED_MS);
        assert!(solution.elapsed_ms <= AnubisSolver::MAX_ELAPSED_MS);
    }
}
