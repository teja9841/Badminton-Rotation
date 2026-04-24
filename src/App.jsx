import { useEffect, useMemo, useState } from "react";
import {
  applyPointToMatch,
  createInitialServeState,
  generateFairMatch,
  getGameConfig,
  getMatchStatus,
  getScoreSettingsSummary,
} from "./lib/engine";

const STORAGE_KEY = "badminton-rotation-session";

function createId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function getDefaultState() {
  return {
    currentScreen: "players",
    returnScreen: "session",
    sessionActive: false,
    sessionWindow: "2:00 PM - 5:00 PM",
    gameMode: "new",
    matchMode: "doubles",
    currentMatchNumber: 0,
    score: { A: 0, B: 0 },
    scoreSettings: {
      winningScore: 21,
      deuceEnabled: true,
      maxCapEnabled: true,
      maxCapScore: 30,
    },
    currentMatchPlayerIds: [],
    teams: { A: [], B: [] },
    serveState: null,
    players: [],
    matchHistory: [],
    draftPlayer: { name: "", gender: "Male" },
    editingPlayerId: null,
    lastError: "",
    lastScoringTeam: null,
    pointAnimationTick: 0,
    shuttleAnimation: null,
  };
}

function loadState() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? { ...getDefaultState(), ...JSON.parse(raw) } : getDefaultState();
  } catch {
    return getDefaultState();
  }
}

function PlayerAvatar({ player, serving, compact = false }) {
  const avatarClass = [
    "player-avatar",
    compact ? "compact" : "",
    player.gender === "Female" ? "female" : "male",
    player.status,
    serving ? "serving" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={avatarClass}>
      <div className="human">
        {serving ? <span className="serve-arrow" /> : null}
        <span className="head" />
        <span className="torso" />
        <span className="arm arm-left" />
        <span className="arm arm-right" />
        <span className="leg leg-left" />
        <span className="leg leg-right" />
        <span className="racket" />
      </div>
      <div className="avatar-meta">
        <strong>{player.name}</strong>
        <span className={`avatar-state ${serving ? "serving" : player.status}`}>{serving ? "Serving" : player.status}</span>
      </div>
    </div>
  );
}

function sortPlayersForLiveUse(players) {
  const statusOrder = {
    playing: 0,
    waiting: 1,
    left: 2,
  };

  return [...players].sort((left, right) => {
    const byStatus = (statusOrder[left.status] ?? 99) - (statusOrder[right.status] ?? 99);

    if (byStatus !== 0) {
      return byStatus;
    }

    if (left.matchesPlayed !== right.matchesPlayed) {
      return left.matchesPlayed - right.matchesPlayed;
    }

    return left.name.localeCompare(right.name);
  });
}

function sortPlayersForLeaderboard(players) {
  return [...players].sort((left, right) => {
    if ((right.totalPoints ?? 0) !== (left.totalPoints ?? 0)) {
      return (right.totalPoints ?? 0) - (left.totalPoints ?? 0);
    }

    if ((right.matchesPlayed ?? 0) !== (left.matchesPlayed ?? 0)) {
      return (right.matchesPlayed ?? 0) - (left.matchesPlayed ?? 0);
    }

    return left.name.localeCompare(right.name);
  });
}

const SLOT_COORDINATES = {
  "a-top": { x: "22%", y: "28%" },
  "a-bottom": { x: "22%", y: "68%" },
  "b-top": { x: "75%", y: "28%" },
  "b-bottom": { x: "75%", y: "68%" },
  "a-center": { x: "22%", y: "50%" },
  "b-center": { x: "75%", y: "50%" },
};

function getCourtAssignments({ teamsDetailed, matchMode }) {
  if (matchMode === "singles") {
    const leftPlayer = teamsDetailed.A[0];
    const rightPlayer = teamsDetailed.B[0];

    return [
      leftPlayer
        ? {
            player: leftPlayer,
            slot: "a-center",
          }
        : null,
      rightPlayer
        ? {
            player: rightPlayer,
            slot: "b-center",
          }
        : null,
    ].filter(Boolean);
  }

  return ["A", "B"].flatMap((team) => {
    const teamPlayers = teamsDetailed[team];

    if (!teamPlayers.length) {
      return [];
    }

    if (teamPlayers.length === 1) {
      return [
        {
          player: teamPlayers[0],
          slot: team === "A" ? "a-top" : "b-top",
        },
      ];
    }

    let orderedPlayers = [...teamPlayers];

    return orderedPlayers.map((player, index) => ({
      player,
      slot:
        team === "A"
          ? index === 0
            ? "a-top"
            : "a-bottom"
          : index === 0
            ? "b-top"
            : "b-bottom",
    }));
  });
}

function getPlayerSlotMap({ teamsDetailed, matchMode }) {
  return new Map(
    getCourtAssignments({ teamsDetailed, matchMode }).map(({ player, slot }) => [player.id, slot]),
  );
}

function getShuttleAnimationStyle({ shuttleAnimation, playerSlotMap }) {
  if (!shuttleAnimation?.fromPlayerId) {
    return null;
  }

  const startSlot = playerSlotMap.get(shuttleAnimation.fromPlayerId);

  if (!startSlot) {
    return null;
  }

  const start = SLOT_COORDINATES[startSlot];
  const end =
    shuttleAnimation.toTeam === "A"
      ? shuttleAnimation.matchMode === "singles"
        ? SLOT_COORDINATES["a-center"]
        : startSlot === "b-top"
          ? SLOT_COORDINATES["a-top"]
          : SLOT_COORDINATES["a-bottom"]
      : shuttleAnimation.matchMode === "singles"
        ? SLOT_COORDINATES["b-center"]
        : startSlot === "a-top"
          ? SLOT_COORDINATES["b-top"]
          : SLOT_COORDINATES["b-bottom"];

  return {
    "--shuttle-start-x": start.x,
    "--shuttle-start-y": start.y,
    "--shuttle-end-x": end.x,
    "--shuttle-end-y": end.y,
  };
}

function App() {
  const [state, setState] = useState(loadState);
  const [form, setForm] = useState(() => loadState().draftPlayer);

  useEffect(() => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        ...state,
        draftPlayer: form,
      }),
    );
  }, [state, form]);

  const currentPlayers = useMemo(() => {
    const playerMap = new Map(state.players.map((player) => [player.id, player]));
    return state.currentMatchPlayerIds.map((id) => playerMap.get(id)).filter(Boolean);
  }, [state.currentMatchPlayerIds, state.players]);

  const teamsDetailed = useMemo(() => {
    const playerMap = new Map(state.players.map((player) => [player.id, player]));
    return {
      A: state.teams.A.map((id) => playerMap.get(id)).filter(Boolean),
      B: state.teams.B.map((id) => playerMap.get(id)).filter(Boolean),
    };
  }, [state.players, state.teams]);

  const courtAssignments = useMemo(() => {
    return getCourtAssignments({
      teamsDetailed,
      matchMode: state.matchMode,
    });
  }, [teamsDetailed, state.matchMode]);

  const waitingPlayers = useMemo(() => {
    const currentIds = new Set(state.currentMatchPlayerIds);
    return state.players.filter((player) => !currentIds.has(player.id) && player.status !== "left");
  }, [state.currentMatchPlayerIds, state.players]);

  const leftPlayers = useMemo(() => {
    return state.players.filter((player) => player.status === "left");
  }, [state.players]);

  const sortedPlayers = useMemo(() => {
    return sortPlayersForLiveUse(state.players);
  }, [state.players]);

  const leaderboardPlayers = useMemo(() => {
    return sortPlayersForLeaderboard(state.players);
  }, [state.players]);

  const playerSlotMap = useMemo(() => {
    return getPlayerSlotMap({
      teamsDetailed,
      matchMode: state.matchMode,
    });
  }, [teamsDetailed, state.matchMode]);

  const shuttleAnimationStyle = useMemo(() => {
    return getShuttleAnimationStyle({
      shuttleAnimation: state.shuttleAnimation,
      playerSlotMap,
    });
  }, [state.shuttleAnimation, playerSlotMap]);

  const activeCount = state.players.filter((player) => player.status !== "left").length;
  const modeLabel = getGameConfig(state.gameMode).label;
  const matchStatus = useMemo(() => {
    return getMatchStatus({
      score: state.score,
      scoreSettings: state.scoreSettings,
    });
  }, [state.score, state.scoreSettings]);

  function updatePlayers(updater) {
    setState((previous) => ({
      ...previous,
      players: typeof updater === "function" ? updater(previous.players) : updater,
    }));
  }

  function clearError() {
    setState((previous) => ({
      ...previous,
      lastError: "",
    }));
  }

  function handleSubmitPlayer(event) {
    event.preventDefault();
    const cleanName = form.name.trim();

    if (!cleanName) {
      setState((previous) => ({
        ...previous,
        lastError: "Please enter a player name",
      }));
      return;
    }

    if (state.editingPlayerId) {
      updatePlayers((players) =>
        players.map((player) =>
          player.id === state.editingPlayerId
            ? { ...player, name: cleanName, gender: form.gender }
            : player,
        ),
      );

      setState((previous) => ({
        ...previous,
        editingPlayerId: null,
        lastError: "",
      }));
    } else {
      updatePlayers((players) => [
        ...players,
        {
          id: createId(),
          name: cleanName,
          gender: form.gender,
          matchesPlayed: 0,
          totalPoints: 0,
          status: "waiting",
          joinedAt: Date.now(),
        },
      ]);
      clearError();
    }

    setForm({ name: "", gender: "Male" });
  }

  function handleEditPlayer(player) {
    setState((previous) => ({
      ...previous,
      editingPlayerId: player.id,
      lastError: "",
    }));
    setForm({ name: player.name, gender: player.gender });
  }

  function handleRemovePlayer(playerId) {
    setState((previous) => {
      const nextPlayers = previous.players.filter((player) => player.id !== playerId);
      const nextCurrentIds = previous.currentMatchPlayerIds.filter((id) => id !== playerId);
      const nextTeams = {
        A: previous.teams.A.filter((id) => id !== playerId),
        B: previous.teams.B.filter((id) => id !== playerId),
      };

      return {
        ...previous,
        players: nextPlayers,
        currentMatchPlayerIds: nextCurrentIds,
        teams: nextTeams,
        serveState:
          previous.serveState?.playerId === playerId
            ? createInitialServeState({
                teams: nextTeams,
                matchMode: previous.matchMode,
                gameMode: previous.gameMode,
              })
            : previous.serveState,
      };
    });
  }

  function handlePlayerLeft(playerId) {
    setState((previous) => {
      const nextPlayers = previous.players.map((player) =>
        player.id === playerId ? { ...player, status: "left" } : player,
      );
      const nextCurrentIds = previous.currentMatchPlayerIds.filter((id) => id !== playerId);
      const nextTeams = {
        A: previous.teams.A.filter((id) => id !== playerId),
        B: previous.teams.B.filter((id) => id !== playerId),
      };

      return {
        ...previous,
        players: nextPlayers,
        currentMatchPlayerIds: nextCurrentIds,
        teams: nextTeams,
        serveState:
          previous.serveState?.playerId === playerId
            ? createInitialServeState({
                teams: nextTeams,
                matchMode: previous.matchMode,
                gameMode: previous.gameMode,
              })
            : previous.serveState,
      };
    });
  }

  function handleReturnPlayer(playerId) {
    updatePlayers((players) =>
      players.map((player) =>
        player.id === playerId ? { ...player, status: "waiting" } : player,
      ),
    );
  }

  function setPlayersPlaying(nextMatchIds, teams) {
    setState((previous) => ({
      ...previous,
      currentMatchPlayerIds: nextMatchIds,
      teams,
      score: { A: 0, B: 0 },
      serveState: createInitialServeState({
        teams,
        matchMode: previous.matchMode,
        gameMode: previous.gameMode,
      }),
      players: previous.players.map((player) => {
        if (player.status === "left") {
          return player;
        }

        return {
          ...player,
          status: nextMatchIds.includes(player.id) ? "playing" : "waiting",
        };
      }),
      lastError: "",
    }));
  }

  function generateAndSetNextMatch({ incrementPrevious }) {
    setState((previous) => {
      let players = previous.players;
      let history = previous.matchHistory;

      if (incrementPrevious && previous.currentMatchPlayerIds.length > 0) {
        const completedIds = new Set(previous.currentMatchPlayerIds);
        const teamAIds = new Set(previous.teams.A);
        const teamBIds = new Set(previous.teams.B);
        players = previous.players.map((player) =>
          completedIds.has(player.id)
            ? {
                ...player,
                matchesPlayed: player.matchesPlayed + 1,
                totalPoints:
                  (player.totalPoints ?? 0) +
                  (teamAIds.has(player.id)
                    ? previous.score.A
                    : teamBIds.has(player.id)
                      ? previous.score.B
                      : 0),
                status: "waiting",
              }
            : player,
        );
        history = [
          ...previous.matchHistory,
          {
            matchNumber: previous.currentMatchNumber,
            players: previous.currentMatchPlayerIds,
            teams: previous.teams,
            score: previous.score,
            completedAt: Date.now(),
          },
        ];
      }

      const generated = generateFairMatch({
        players,
        matchMode: previous.matchMode,
        matchHistory: history,
      });

      if (generated.error) {
        return {
          ...previous,
          players,
          matchHistory: history,
          lastError: generated.error,
        };
      }

      const nextTeams = generated.teams;
      const nextMatchIds = generated.players;

      return {
        ...previous,
        players: players.map((player) => {
          if (player.status === "left") {
            return player;
          }

          return {
            ...player,
            status: nextMatchIds.includes(player.id) ? "playing" : "waiting",
          };
        }),
        matchHistory: history,
        currentMatchPlayerIds: nextMatchIds,
        teams: nextTeams,
        currentMatchNumber: incrementPrevious ? previous.currentMatchNumber + 1 : Math.max(previous.currentMatchNumber, 1),
        score: { A: 0, B: 0 },
        serveState: createInitialServeState({
          teams: nextTeams,
          matchMode: previous.matchMode,
          gameMode: previous.gameMode,
        }),
        sessionActive: true,
        lastError: "",
      };
    });
  }

  function handleStartSession() {
    if (activeCount < (state.matchMode === "singles" ? 2 : 4)) {
      setState((previous) => ({
        ...previous,
        lastError: "Not enough players",
      }));
      return;
    }

    generateAndSetNextMatch({ incrementPrevious: false });
    setState((previous) => ({
      ...previous,
      currentScreen: "live",
      returnScreen: "live",
    }));
  }

  function handleNextMatch() {
    if (!state.currentMatchPlayerIds.length) {
      handleStartSession();
      return;
    }

    generateAndSetNextMatch({ incrementPrevious: true });
  }

  function handleScore(team) {
    if (!state.serveState || matchStatus.gameOver) {
      return;
    }

    setState((previous) => {
      const updated = applyPointToMatch({
        scoringTeam: team,
        serveState: previous.serveState,
        gameMode: previous.gameMode,
        matchMode: previous.matchMode,
        teams: previous.teams,
        score: previous.score,
      });

      return {
        ...previous,
        score: updated.score,
        serveState: updated.serveState,
        lastScoringTeam: team,
        pointAnimationTick: previous.pointAnimationTick + 1,
        shuttleAnimation: {
          fromPlayerId: previous.serveState?.playerId ?? null,
          toTeam: team,
          matchMode: previous.matchMode,
        },
      };
    });
  }

  function handleResetScore() {
    setState((previous) => ({
      ...previous,
      score: { A: 0, B: 0 },
      serveState: previous.currentMatchPlayerIds.length
        ? createInitialServeState({
            teams: previous.teams,
            matchMode: previous.matchMode,
            gameMode: previous.gameMode,
          })
        : null,
      lastScoringTeam: null,
      shuttleAnimation: null,
      }));
  }

  function handleResetSession() {
    setState((previous) => ({
      ...previous,
      sessionActive: false,
      currentScreen: "session",
      returnScreen: "session",
      currentMatchNumber: 0,
      currentMatchPlayerIds: [],
      teams: { A: [], B: [] },
      serveState: null,
      score: { A: 0, B: 0 },
      lastScoringTeam: null,
      pointAnimationTick: 0,
      shuttleAnimation: null,
      matchHistory: [],
      players: previous.players.map((player) => ({
        ...player,
        matchesPlayed: 0,
        status: player.status === "left" ? "left" : "waiting",
      })),
      lastError: "",
    }));
  }

  function handleClearPlayers() {
    setState(getDefaultState());
    setForm({ name: "", gender: "Male" });
  }

  function handleModeChange(nextMode) {
    setState((previous) => ({
      ...previous,
      sessionActive: false,
      currentScreen: "session",
      returnScreen: "session",
      matchMode: nextMode,
      currentMatchNumber: 0,
      currentMatchPlayerIds: [],
      teams: { A: [], B: [] },
      score: { A: 0, B: 0 },
      serveState: null,
      lastScoringTeam: null,
      pointAnimationTick: 0,
      shuttleAnimation: null,
      matchHistory: [],
      players: previous.players.map((player) =>
        player.status === "left" ? player : { ...player, status: "waiting" },
      ),
      lastError: "",
    }));
  }

  function handleGameModeChange(nextGameMode) {
    setState((previous) => ({
      ...previous,
      gameMode: nextGameMode,
      serveState:
        previous.currentMatchPlayerIds.length > 0
          ? createInitialServeState({
              teams: previous.teams,
              matchMode: previous.matchMode,
              gameMode: nextGameMode,
            })
          : null,
      lastScoringTeam: null,
      shuttleAnimation: null,
      lastError: "",
    }));
  }

  function updateScoreSettings(partial) {
    setState((previous) => ({
      ...previous,
      scoreSettings: {
        ...previous.scoreSettings,
        ...partial,
      },
    }));
  }

  function goToPlayers(returnScreen = "session") {
    setState((previous) => ({
      ...previous,
      currentScreen: "players",
      returnScreen,
      lastError: "",
    }));
  }

  function goToSession() {
    setState((previous) => ({
      ...previous,
      currentScreen: "session",
      returnScreen: previous.sessionActive ? "live" : "session",
      lastError: "",
    }));
  }

  function goToLive() {
    setState((previous) => ({
      ...previous,
      currentScreen: "live",
      returnScreen: "live",
      lastError: "",
    }));
  }

  const canReturnToLive = state.sessionActive && state.currentMatchPlayerIds.length > 0;

  return (
    <div className="app-shell sports-shell">
      <header className="hero-card premium-hero">
        <div>
          <p className="eyebrow">Personal Match Rotation</p>
          <h1>Badminton Court Manager</h1>
          <p className="hero-copy">
            Fair random matches, live score tracking, and quick player rotation for mobile courtside use.
          </p>
        </div>

        <div className="hero-summary">
          <div className="stat-chip">
            <span>Players</span>
            <strong>{activeCount}</strong>
          </div>
          <div className="stat-chip">
            <span>Mode</span>
            <strong>{state.matchMode === "singles" ? "Singles" : "Doubles"}</strong>
          </div>
          <div className="stat-chip">
            <span>Rules</span>
            <strong>{modeLabel}</strong>
          </div>
        </div>
      </header>

      <main className={`main-stack screen-${state.currentScreen}`}>
        <div className="screen-indicator">
          <span className={state.currentScreen === "players" ? "active step-item" : "step-item"}>Players</span>
          <span className={state.currentScreen === "session" ? "active step-item" : "step-item"}>Session</span>
          <span className={state.currentScreen === "live" ? "active step-item" : "step-item"}>Live</span>
          <span className={state.currentScreen === "leaderboard" ? "active step-item" : "step-item"}>Top</span>
        </div>

        {state.currentScreen === "players" ? (
          <>
            <section className="panel players-panel">
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">Screen 1</p>
                  <h2>Player Management</h2>
                </div>
                <span className="match-badge">{state.players.length} saved</span>
              </div>

              <form className="player-form premium-form" onSubmit={handleSubmitPlayer}>
                <label className="field">
                  <span>Name</span>
                  <input
                    onChange={(event) => setForm((previous) => ({ ...previous, name: event.target.value }))}
                    placeholder="Add player"
                    value={form.name}
                  />
                </label>

                <label className="field">
                  <span>Gender</span>
                  <select
                    onChange={(event) => setForm((previous) => ({ ...previous, gender: event.target.value }))}
                    value={form.gender}
                  >
                    <option value="Male">Male</option>
                    <option value="Female">Female</option>
                  </select>
                </label>

                <button className="primary-action" type="submit">
                  {state.editingPlayerId ? "Save Player" : "Add Player"}
                </button>
              </form>

              <div className="action-grid single-column">
                <button className="primary-action alt" onClick={goToSession} type="button">
                  Save Players & Continue
                </button>
                {canReturnToLive ? (
                  <button className="ghost-action" onClick={goToLive} type="button">
                    Return to Live Session
                  </button>
                ) : null}
                <button className="ghost-action" onClick={handleClearPlayers} type="button">
                  Clear All Players
                </button>
              </div>

              {state.lastError ? <p className="error-text">{state.lastError}</p> : null}
            </section>

            <section className="panel roster-panel">
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">Saved Players</p>
                  <h2>Ready List</h2>
                </div>
              </div>

              <div className="waiting-list">
                {waitingPlayers.length || currentPlayers.length ? (
                  sortedPlayers
                    .filter((player) => player.status !== "left")
                    .map((player) => (
                      <article className="player-card" key={player.id}>
                        <PlayerAvatar compact player={player} serving={state.serveState?.playerId === player.id} />
                        <div className="player-card-meta">
                          <span className={`status-badge ${player.status}`}>{player.status}</span>
                          <span>{player.gender}</span>
                          <strong>{player.matchesPlayed} matches</strong>
                        </div>
                        <div className="player-actions">
                          <button onClick={() => handleEditPlayer(player)} type="button">
                            Edit
                          </button>
                          <button onClick={() => handlePlayerLeft(player.id)} type="button">
                            Left
                          </button>
                          <button className="danger" onClick={() => handleRemovePlayer(player.id)} type="button">
                            Remove
                          </button>
                        </div>
                      </article>
                    ))
                ) : (
                  <div className="empty-state">Add players to begin the session.</div>
                )}
              </div>
            </section>

            {leftPlayers.length ? (
            <section className="panel left-panel">
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">Inactive</p>
                    <h2>Players Who Left</h2>
                  </div>
                </div>

                <div className="waiting-list">
                  {leftPlayers.map((player) => (
                    <article className="player-card left-card" key={player.id}>
                      <PlayerAvatar compact player={player} serving={false} />
                      <div className="player-card-meta">
                        <span className={`status-badge ${player.status}`}>{player.status}</span>
                        <span>{player.gender}</span>
                        <strong>{player.matchesPlayed} matches</strong>
                      </div>
                      <div className="player-actions">
                        <button onClick={() => handleReturnPlayer(player.id)} type="button">
                          Rejoin
                        </button>
                        <button className="danger" onClick={() => handleRemovePlayer(player.id)} type="button">
                          Remove
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            ) : null}
          </>
        ) : null}

        {state.currentScreen === "session" ? (
          <section className="panel session-panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Screen 2</p>
                <h2>Session Controls</h2>
              </div>
              <span className={`session-pill ${state.sessionActive ? "active" : ""}`}>
                {state.sessionActive ? "Session Running" : "Ready"}
              </span>
            </div>

            <div className="panel-grid">
              <label className="field">
                <span>Session Time</span>
                <input
                  value={state.sessionWindow}
                  onChange={(event) =>
                    setState((previous) => ({
                      ...previous,
                      sessionWindow: event.target.value,
                    }))
                  }
                />
              </label>

              <div className="toggle-group">
                <span>Match Type</span>
                <div className="segmented">
                  <button
                    className={state.matchMode === "singles" ? "selected" : ""}
                    onClick={() => handleModeChange("singles")}
                    type="button"
                  >
                    Singles
                  </button>
                  <button
                    className={state.matchMode === "doubles" ? "selected" : ""}
                    onClick={() => handleModeChange("doubles")}
                    type="button"
                  >
                    Doubles
                  </button>
                </div>
              </div>

              <div className="toggle-group">
                <span>Game Mode</span>
                <div className="segmented">
                  <button
                    className={state.gameMode === "old" ? "selected" : ""}
                    onClick={() => handleGameModeChange("old")}
                    type="button"
                  >
                    Old Game
                  </button>
                  <button
                    className={state.gameMode === "new" ? "selected" : ""}
                    onClick={() => handleGameModeChange("new")}
                    type="button"
                  >
                    New Game
                  </button>
                </div>
              </div>

              <div className="panel-grid score-settings-grid">
                <label className="field">
                  <span>Winning Score</span>
                  <div className="preset-row">
                    {[11, 15, 21].map((value) => (
                      <button
                        key={value}
                        className={state.scoreSettings.winningScore === value ? "preset-chip selected" : "preset-chip"}
                        onClick={() => updateScoreSettings({ winningScore: value })}
                        type="button"
                      >
                        {value}
                      </button>
                    ))}
                  </div>
                  <input
                    min="1"
                    onChange={(event) =>
                      updateScoreSettings({
                        winningScore: Math.max(1, Number(event.target.value) || 1),
                      })
                    }
                    type="number"
                    value={state.scoreSettings.winningScore}
                  />
                </label>

                <div className="toggle-group">
                  <span>Deuce</span>
                  <div className="segmented">
                    <button
                      className={state.scoreSettings.deuceEnabled ? "selected" : ""}
                      onClick={() => updateScoreSettings({ deuceEnabled: true })}
                      type="button"
                    >
                      Enabled
                    </button>
                    <button
                      className={!state.scoreSettings.deuceEnabled ? "selected" : ""}
                      onClick={() => updateScoreSettings({ deuceEnabled: false })}
                      type="button"
                    >
                      Disabled
                    </button>
                  </div>
                </div>

                <div className="toggle-group">
                  <span>Max Cap</span>
                  <div className="segmented">
                    <button
                      className={state.scoreSettings.maxCapEnabled ? "selected" : ""}
                      onClick={() => updateScoreSettings({ maxCapEnabled: true })}
                      type="button"
                    >
                      Enabled
                    </button>
                    <button
                      className={!state.scoreSettings.maxCapEnabled ? "selected" : ""}
                      onClick={() => updateScoreSettings({ maxCapEnabled: false })}
                      type="button"
                    >
                      Disabled
                    </button>
                  </div>
                </div>

                <label className="field">
                  <span>Max Cap Score</span>
                  <input
                    disabled={!state.scoreSettings.maxCapEnabled}
                    min={state.scoreSettings.winningScore}
                    onChange={(event) =>
                      updateScoreSettings({
                        maxCapScore: Math.max(
                          state.scoreSettings.winningScore,
                          Number(event.target.value) || state.scoreSettings.winningScore,
                        ),
                      })
                    }
                    type="number"
                    value={state.scoreSettings.maxCapScore}
                  />
                </label>
              </div>
            </div>

            <div className="action-grid single-column">
              <button className="primary-action" onClick={handleStartSession} type="button">
                Start Session
              </button>
              <button className="ghost-action" onClick={() => goToPlayers("session")} type="button">
                Back to Player Management
              </button>
              {state.sessionActive ? (
                <button className="ghost-action" onClick={goToLive} type="button">
                  Return to Live Session
                </button>
              ) : null}
            </div>

            {state.lastError ? <p className="error-text">{state.lastError}</p> : null}
            <p className="helper-text">{getScoreSettingsSummary(state.scoreSettings)}</p>
          </section>
        ) : null}

        {state.currentScreen === "live" ? (
          <>
            <section className="panel live-score-panel">
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">Screen 3</p>
                  <h2>Live Scoring</h2>
                </div>
                <span className="session-pill active">{modeLabel}</span>
              </div>

              <div className="score-grid">
                <div
                  className={`score-card team-a ${state.lastScoringTeam === "A" ? "point-win" : ""}`}
                >
                  <span>Team A</span>
                  <strong>{state.score.A}</strong>
                  <button className="score-button" onClick={() => handleScore("A")} type="button">
                    +1
                  </button>
                </div>
                <div
                  className={`score-card team-b ${state.lastScoringTeam === "B" ? "point-win" : ""}`}
                >
                  <span>Team B</span>
                  <strong>{state.score.B}</strong>
                  <button className="score-button" onClick={() => handleScore("B")} type="button">
                    +1
                  </button>
                </div>
              </div>

              <div className={`match-status-banner status-${matchStatus.type}`}>
                <span>Match Status</span>
                <strong>{matchStatus.text}</strong>
              </div>

              <div className="serve-banner">
                <span>Current Server</span>
                <strong>
                  {state.players.find((player) => player.id === state.serveState?.playerId)?.name ?? "Waiting for match"}
                </strong>
              </div>
            </section>

            <section className="panel court-panel premium-court-panel">
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">Court View</p>
                  <h2>Active Match</h2>
                </div>
                <div className="match-badge">
                  Match <strong>{state.currentMatchNumber || "-"}</strong>
                </div>
              </div>

              <div
                className={`court mode-${state.matchMode} ${
                  state.lastScoringTeam ? `flash-${state.lastScoringTeam.toLowerCase()}` : ""
                }`}
              >
                <div className="court-team-tint team-a" />
                <div className="court-team-tint team-b" />
                <div className="court-markings" aria-hidden="true">
                  <span className="court-line vertical boundary-left" />
                  <span className="court-line vertical boundary-right" />
                  <span className="court-line vertical doubles-left" />
                  <span className="court-line vertical doubles-right" />
                  <span className="court-line vertical singles-left" />
                  <span className="court-line vertical singles-right" />
                  <span className="court-line vertical center-service" />
                  <span className="court-line horizontal boundary-top" />
                  <span className="court-line horizontal boundary-bottom" />
                  <span className="court-line horizontal short-service-top" />
                  <span className="court-line horizontal short-service-bottom" />
                  <span className="court-line horizontal net-line" />
                </div>
                <div className="court-net" />
                {shuttleAnimationStyle ? (
                  <div
                    className="shuttlecock shuttle-flight"
                    style={shuttleAnimationStyle}
                    key={`shuttle-${state.pointAnimationTick}`}
                  />
                ) : null}
                {courtAssignments.map(({ player, slot }) => (
                  <div
                    key={player.id}
                    className={`court-slot slot-${slot}`}
                  >
                    <PlayerAvatar
                      player={player}
                      serving={state.serveState?.playerId === player.id}
                    />
                  </div>
                ))}
                {!currentPlayers.length ? (
                  <div className="empty-court">
                    <strong>No active match</strong>
                    <span>Tap Start Session when enough players are ready.</span>
                  </div>
                ) : null}
              </div>

              <div className="team-strip">
                <div className="team-card team-a-card">
                  <span className="team-label">Team A</span>
                  <strong>{teamsDetailed.A.map((player) => player.name).join(" + ") || "-"}</strong>
                </div>
                <div className="team-card team-b-card">
                  <span className="team-label">Team B</span>
                  <strong>{teamsDetailed.B.map((player) => player.name).join(" + ") || "-"}</strong>
                </div>
              </div>
            </section>

            <section className="panel live-bottom-panel">
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">Bottom Panel</p>
                  <h2>Queue & Match Stats</h2>
                </div>
                <span className="match-badge">{waitingPlayers.length} waiting</span>
              </div>

              <div className="live-info-grid">
                <div className="live-info-card">
                  <div className="subpanel-heading">
                    <h3>Queue</h3>
                    <span>{waitingPlayers.length}</span>
                  </div>

                  <div className="waiting-list compact-list">
                    {waitingPlayers.length ? (
                      waitingPlayers.map((player) => (
                        <article className="player-card" key={player.id}>
                          <PlayerAvatar compact player={player} serving={false} />
                          <div className="player-card-meta">
                            <span className={`status-badge ${player.status}`}>{player.status}</span>
                            <span>{player.gender}</span>
                            <strong>{player.matchesPlayed} matches</strong>
                          </div>
                        </article>
                      ))
                    ) : (
                      <div className="empty-state">No one is waiting right now.</div>
                    )}
                  </div>
                </div>

                <div className="live-info-card">
                  <div className="subpanel-heading">
                    <h3>Match Stats</h3>
                    <span>{state.players.length}</span>
                  </div>

                  <div className="stats-list live-stats-list compact-list">
                    {state.players.length ? (
                      sortedPlayers.map((player) => (
                        <article className="stats-card" key={player.id}>
                          <div>
                            <strong>{player.name}</strong>
                            <span>{player.gender}</span>
                          </div>
                          <div>
                            <strong>{player.matchesPlayed}</strong>
                            <span>Matches</span>
                          </div>
                          <div>
                            <strong className={`status-inline ${player.status}`}>{player.status}</strong>
                            <span>Status</span>
                          </div>
                        </article>
                      ))
                    ) : (
                      <div className="empty-state">Add players to begin the session.</div>
                    )}
                  </div>
                </div>
              </div>

              <div className="action-grid single-column live-action-dock">
                <button className="primary-action alt" onClick={handleNextMatch} type="button">
                  Next Match
                </button>
                <button className="ghost-action" onClick={handleResetScore} type="button">
                  Reset Score
                </button>
                <button className="ghost-action" onClick={() => goToPlayers("live")} type="button">
                  Edit Players
                </button>
                <button
                  className="ghost-action"
                  onClick={() =>
                    setState((previous) => ({
                      ...previous,
                      currentScreen: "leaderboard",
                      returnScreen: "live",
                    }))
                  }
                  type="button"
                >
                  View Leaderboard
                </button>
                <button className="ghost-action" onClick={handleResetSession} type="button">
                  End Session
                </button>
              </div>
            </section>
          </>
        ) : null}

        {state.currentScreen === "leaderboard" ? (
          <section className="panel leaderboard-panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Screen 4</p>
                <h2>Leaderboard</h2>
              </div>
              <span className="match-badge">{leaderboardPlayers.length} players</span>
            </div>

            {state.matchHistory.length ? (
              <div className="leaderboard-list">
                {leaderboardPlayers.map((player, index) => {
                  const rank = index + 1;
                  const average =
                    player.matchesPlayed > 0
                      ? ((player.totalPoints ?? 0) / player.matchesPlayed).toFixed(1)
                      : "0.0";

                  return (
                    <article
                      className={`leaderboard-card ${
                        rank === 1 ? "rank-gold" : rank === 2 ? "rank-silver" : rank === 3 ? "rank-bronze" : ""
                      }`}
                      key={player.id}
                    >
                      <div className="leaderboard-rank">#{rank}</div>
                      <PlayerAvatar compact player={player} serving={false} />
                      <div className="leaderboard-main">
                        <strong>{player.name}</strong>
                        <span>{player.gender}</span>
                      </div>
                      <div className="leaderboard-stat">
                        <strong>{player.totalPoints ?? 0}</strong>
                        <span>Total Points</span>
                      </div>
                      <div className="leaderboard-stat">
                        <strong>{player.matchesPlayed}</strong>
                        <span>Matches</span>
                      </div>
                      <div className="leaderboard-stat">
                        <strong>{average}</strong>
                        <span>Avg / Match</span>
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : (
              <div className="empty-state">No leaderboard data yet. Play a match to see rankings.</div>
            )}

            <div className="action-grid single-column">
              <button
                className="primary-action"
                onClick={() =>
                  setState((previous) => ({
                    ...previous,
                    currentScreen: previous.sessionActive ? "live" : "session",
                    returnScreen: previous.sessionActive ? "live" : "session",
                  }))
                }
                type="button"
              >
                {state.sessionActive ? "Back to Live" : "Back to Session"}
              </button>
            </div>
          </section>
        ) : null}
      </main>
    </div>
  );
}

export default App;
