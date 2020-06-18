import * as fp from 'fastify-plugin';
import { S2GameLobby } from '../../../entity/S2GameLobby';
import { S2GameLobbySlotKind } from '../../../entity/S2GameLobbySlot';
import { S2StatsPeriodMap } from '../../../entity/S2StatsPeriodMap';
import { S2StatsPeriod } from '../../../entity/S2StatsPeriod';

export default fp(async (server, opts, next) => {
    server.get('/maps/:regionId/:mapId/stats', {
        schema: {
            tags: ['Maps'],
            summary: 'Map statistics',
            params: {
                type: 'object',
                required: ['regionId', 'mapId'],
                properties: {
                    regionId: {
                        type: 'number',
                    },
                    mapId: {
                        type: 'number',
                    },
                },
            },
        },
    }, async (request, reply) => {
        const statPeriods = await server.conn.getRepository(S2StatsPeriod)
            .createQueryBuilder('stPer')
            .select([])
            .addSelect('stPer.id', 'statId')
            .addSelect('CAST(DATE_ADD(stPer.dateFrom, INTERVAL (stPer.length - 1) DAY) AS CHAR)', 'date')
            .andWhere('stPer.length = :length', { length: 7 })
            .addOrderBy('stPer.dateFrom', 'ASC')
            .getRawMany()
        ;
        const tmpResult = await server.conn.getRepository(S2StatsPeriodMap)
            .createQueryBuilder('stMap')
            .select([])
            .innerJoin('stMap.document', 'doc')
            .innerJoin('stMap.period', 'stPer')
            .addSelect('stPer.id', 'statId')
            .addSelect('stMap.lobbiesHosted', 'lobbiesHosted')
            .addSelect('stMap.lobbiesStarted', 'lobbiesStarted')
            .addSelect('stMap.participantsTotal', 'participantsTotal')
            .addSelect('stMap.participantsUniqueTotal', 'participantsUniqueTotal')
            .addSelect('stMap.pendingTimeAverage', 'pendingTimeAverage')
            .andWhere('stPer.id IN (:ids)', { ids: statPeriods.map(x => x.statId) })
            .andWhere('doc.regionId = :regionId AND doc.bnetId = :bnetId', {
                regionId: request.params.regionId,
                bnetId: request.params.mapId,
            })
            .addOrderBy('stPer.dateFrom', 'ASC')
            .getRawMany()
        ;
        const statMap = new Map(tmpResult.map(x => {
            x.pendingTimeAverage = Number(x.pendingTimeAverage);
            const statId = x.statId;
            delete x.statId;
            return [statId, x];
        }));
        statPeriods.forEach(x => {
            if (!statMap.has(x.statId)) {
                statMap.set(x.statId, {
                    lobbiesHosted: 0,
                    lobbiesStarted: 0,
                    participantsTotal: 0,
                    participantsUniqueTotal: 0,
                    pendingTimeAverage: 0,
                    date: x.date,
                });
            }
            else {
                statMap.get(x.statId).date = x.date;
            }
        });

        const organizedResult = Array.from(statMap.entries()).sort((a, b) => a[0] - b[0]).map(x => x[1]);
        const finalResult: {[key: string]: number[]} = {};
        for (const k in organizedResult[0]) {
            finalResult[k] = organizedResult.flatMap(x => x[k]);
        }

        return reply.type('application/json').code(200).send(finalResult);
    });
});
