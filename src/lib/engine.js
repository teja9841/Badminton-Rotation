const GAME_CONFIG = {
  new: {
    label: "New Game",
    pointsPerRallyWinner: true,
    doublesUsesSecondServer: false,
    initialServingTeam: "A",
  },
  old: {
    label: "Old Game",
    pointsPerRallyWinner: false,
    doublesUsesSecondServer: true,
    initialServingTeam: "A",
  },
};

export function getGameConfig(gameMode) {
  return GAME_CONFIG[gameMode] ?? GAME_CONFIG.new;
}

export function getScoreSettingsSummary(scoreSettings) {
  const capText = scoreSettings.maxCapEnabled && scoreSettings.maxCapScore
    ? `Cap ${scoreSettings.maxCapScore}`
    : "No cap";

  return `Race to ${scoreSettings.winningScore} • ${scoreSettings.deuceEnabled ? "Deuce on" : "Deuce off"} • ${capText}`;
}

function shuffle(list) {
  const copy = [...list];

  for (let index = copy.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[randomIndex]] = [copy[randomIndex], copy[index]];
  }

  return copy;
}

function combinations(items, size) {
  const output = [];

  function walk(start, bucket) {
    if (bucket.length === size) {
      output.push(bucket);
      return;
    }

    for (let index = start; index < items.length; index += 1) {
      walk(index + 1, [...bucket, items[index]]);
    }
  }

  walk(0, []);
  return output;
}

function countOverlap(source, target) {
  const targetSet = new Set(target);
  return source.filter((id) => targetSet.has(id)).length;
}

function teamKey(ids) {
  return [...ids].sort().join("|");
}

function matchKey(ids) {
  return [...ids].sort().join("|");
}

function buildHistoryIndex(matchHistory) {
  const recentMatches = matchHistory.slice(-6);
  const recentGroups = new Map();
  const teammateCounts = new Map();
  const opponentCounts = new Map();

  recentMatches.forEach((match, recencyIndex) => {
    const freshnessWeight = recentMatches.length - recencyIndex;
    recentGroups.set(matchKey(match.players), freshnessWeight);

    const teamA = match.teams?.A ?? [];
    const teamB = match.teams?.B ?? [];

    [teamA, teamB].forEach((team) => {
      team.forEach((firstId, firstIndex) => {
        for (let secondIndex = firstIndex + 1; secondIndex < team.length; secondIndex += 1) {
          const secondId = team[secondIndex];
          const key = teamKey([firstId, secondId]);
          teammateCounts.set(key, (teammateCounts.get(key) ?? 0) + freshnessWeight);
        }
      });
    });

    teamA.forEach((aId) => {
      teamB.forEach((bId) => {
        const key = teamKey([aId, bId]);
        opponentCounts.set(key, (opponentCounts.get(key) ?? 0) + freshnessWeight);
      });
    });
  });

  return {
    recentGroups,
    teammateCounts,
    opponentCounts,
  };
}

function scoreCandidateGroup(group, historyIndex) {
  const sortedCounts = [...group].map((player) => player.matchesPlayed).sort((left, right) => left - right);
  const maxCount = sortedCounts[sortedCounts.length - 1];
  const minCount = sortedCounts[0];
  const sumCount = sortedCounts.reduce((total, value) => total + value, 0);
  const repeatedGroupPenalty = historyIndex.recentGroups.get(matchKey(group.map((player) => player.id))) ?? 0;

  return [
    maxCount,
    minCount,
    sumCount,
    repeatedGroupPenalty,
  ];
}

function compareScore(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] < right[index]) {
      return -1;
    }

    if (left[index] > right[index]) {
      return 1;
    }
  }

  return 0;
}

function pickBestTeamSplit(players, historyIndex) {
  if (players.length === 2) {
    return {
      A: [players[0].id],
      B: [players[1].id],
    };
  }

  const [first, second, third, fourth] = players;
  const possibleSplits = [
    {
      A: [first.id, second.id],
      B: [third.id, fourth.id],
    },
    {
      A: [first.id, third.id],
      B: [second.id, fourth.id],
    },
    {
      A: [first.id, fourth.id],
      B: [second.id, third.id],
    },
  ];

  const ranked = shuffle(possibleSplits)
    .map((split) => {
      const teamAKey = teamKey(split.A);
      const teamBKey = teamKey(split.B);
      const repeatTeammatePenalty =
        (historyIndex.teammateCounts.get(teamAKey) ?? 0) +
        (historyIndex.teammateCounts.get(teamBKey) ?? 0);

      const repeatOpponentPenalty = split.A.reduce((total, playerId) => {
        return total + split.B.reduce((sideTotal, opponentId) => {
          return sideTotal + (historyIndex.opponentCounts.get(teamKey([playerId, opponentId])) ?? 0);
        }, 0);
      }, 0);

      return {
        split,
        score: [repeatTeammatePenalty, repeatOpponentPenalty],
      };
    })
    .sort((left, right) => compareScore(left.score, right.score));

  return ranked[0]?.split ?? possibleSplits[0];
}

export function generateFairMatch({ players, matchMode, matchHistory }) {
  const activePool = players.filter((player) => player.status !== "left");
  const slots = matchMode === "singles" ? 2 : 4;

  if (activePool.length < slots) {
    return {
      error: "Not enough players",
    };
  }

  const historyIndex = buildHistoryIndex(matchHistory);

  // Fairness is decided in two layers:
  // 1. Prefer the group with the lowest match counts.
  // 2. Break ties by avoiding recently repeated groups, then shuffle ties so
  //    the same players do not get picked in a predictable order every time.
  const candidateGroups = combinations(shuffle(activePool), slots)
    .map((group) => ({
      group,
      score: scoreCandidateGroup(group, historyIndex),
    }))
    .sort((left, right) => compareScore(left.score, right.score));

  const bestScore = candidateGroups[0]?.score;
  const finalists = candidateGroups.filter((candidate) => compareScore(candidate.score, bestScore) === 0);
  const chosenGroup = shuffle(finalists)[0]?.group ?? candidateGroups[0]?.group ?? [];
  const teams = pickBestTeamSplit(chosenGroup, historyIndex);

  return {
    players: chosenGroup.map((player) => player.id),
    teams,
  };
}

export function createInitialServeState({ teams, matchMode, gameMode }) {
  const config = getGameConfig(gameMode);

  return {
    team: config.initialServingTeam,
    serverIndexByTeam: {
      A: 0,
      B: 0,
    },
    teamHasSecondServer: {
      A: false,
      B: false,
    },
    playerId: teams[config.initialServingTeam]?.[0] ?? null,
    matchMode,
  };
}

function advanceServingPlayer(serveState, teams) {
  const teamPlayers = teams[serveState.team] ?? [];
  const nextIndex = teamPlayers.length <= 1 ? 0 : (serveState.serverIndexByTeam[serveState.team] + 1) % teamPlayers.length;

  return {
    ...serveState,
    serverIndexByTeam: {
      ...serveState.serverIndexByTeam,
      [serveState.team]: nextIndex,
    },
    playerId: teamPlayers[nextIndex] ?? teamPlayers[0] ?? null,
  };
}

function switchServingTeam(serveState, teams) {
  const nextTeam = serveState.team === "A" ? "B" : "A";
  const nextPlayers = teams[nextTeam] ?? [];

  return {
    ...serveState,
    team: nextTeam,
    playerId: nextPlayers[serveState.serverIndexByTeam[nextTeam] ?? 0] ?? nextPlayers[0] ?? null,
  };
}

export function applyPointToMatch({
  scoringTeam,
  serveState,
  gameMode,
  matchMode,
  teams,
  score,
}) {
  const config = getGameConfig(gameMode);
  const nextScore = { ...score };
  let nextServeState = { ...serveState };

  // The serve rules are intentionally centralized here so the UI can stay dumb.
  // "New Game" uses rally scoring. "Old Game" uses side-out scoring, where only
  // the serving side scores. Doubles in old mode also allows a second server.
  if (config.pointsPerRallyWinner) {
    nextScore[scoringTeam] += 1;

    if (nextServeState.team !== scoringTeam) {
      nextServeState = switchServingTeam(nextServeState, teams);

      if (matchMode === "doubles") {
        nextServeState = advanceServingPlayer(nextServeState, teams);
      }
    }
  } else if (nextServeState.team === scoringTeam) {
    nextScore[scoringTeam] += 1;
  } else if (matchMode === "doubles" && config.doublesUsesSecondServer && !nextServeState.teamHasSecondServer[nextServeState.team]) {
    nextServeState = {
      ...advanceServingPlayer(nextServeState, teams),
      teamHasSecondServer: {
        ...nextServeState.teamHasSecondServer,
        [nextServeState.team]: true,
      },
    };
  } else {
    nextServeState = switchServingTeam(nextServeState, teams);
    nextServeState = {
      ...nextServeState,
      teamHasSecondServer: {
        A: false,
        B: false,
      },
    };
  }

  return {
    score: nextScore,
    serveState: {
      ...nextServeState,
      playerId:
        teams[nextServeState.team]?.[nextServeState.serverIndexByTeam[nextServeState.team] ?? 0] ??
        teams[nextServeState.team]?.[0] ??
        null,
    },
  };
}

export function getMatchStatus({ score, scoreSettings }) {
  const teamA = score.A;
  const teamB = score.B;
  const highScore = Math.max(teamA, teamB);
  const lowScore = Math.min(teamA, teamB);
  const leader = teamA === teamB ? null : teamA > teamB ? "A" : "B";
  const target = Number(scoreSettings.winningScore) || 21;
  const deuceEnabled = Boolean(scoreSettings.deuceEnabled);
  const maxCapEnabled = Boolean(scoreSettings.maxCapEnabled);
  const maxCapScore = Number(scoreSettings.maxCapScore) || null;
  const deuceTrigger = target - 1;

  if (maxCapEnabled && maxCapScore && highScore >= maxCapScore) {
    return {
      type: "winner",
      team: leader,
      text: leader ? `Winner: Team ${leader}` : "Winner",
      gameOver: true,
    };
  }

  if (!deuceEnabled) {
    if (highScore >= target) {
      return {
        type: "winner",
        team: leader,
        text: leader ? `Winner: Team ${leader}` : "Winner",
        gameOver: true,
      };
    }

    if (leader && highScore === target - 1) {
      return {
        type: "game-point",
        team: leader,
        text: `Game Point Team ${leader}`,
        gameOver: false,
      };
    }

    return {
      type: "live",
      team: null,
      text: "Game On",
      gameOver: false,
    };
  }

  const inDeuceWindow = teamA >= deuceTrigger && teamB >= deuceTrigger;

  if (inDeuceWindow) {
    if (highScore >= target && highScore - lowScore >= 2) {
      return {
        type: "winner",
        team: leader,
        text: leader ? `Winner: Team ${leader}` : "Winner",
        gameOver: true,
      };
    }

    if (teamA === teamB) {
      return {
        type: "deuce",
        team: null,
        text: "Deuce",
        gameOver: false,
      };
    }

    if (leader && highScore - lowScore === 1) {
      return {
        type: "advantage",
        team: leader,
        text: `Advantage Team ${leader}`,
        gameOver: false,
      };
    }
  } else if (leader && highScore === target - 1) {
    return {
      type: "game-point",
      team: leader,
      text: `Game Point Team ${leader}`,
      gameOver: false,
    };
  }

  return {
    type: "live",
    team: null,
    text: "Game On",
    gameOver: false,
  };
}
