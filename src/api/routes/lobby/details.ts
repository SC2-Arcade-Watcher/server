import * as fp from 'fastify-plugin';
import { S2GameLobbyRepository } from '../../../repository/S2GameLobbyRepository';

export default fp(async (server, opts, next) => {
    server.get('/lobbies/:regionId/:bnetBucketId/:bnetRecordId', {
        schema: {
            tags: ['Lobbies'],
            summary: 'Lobby details',
            params: {
                type: 'object',
                required: ['regionId', 'bnetBucketId', 'bnetRecordId'],
                properties: {
                    regionId: {
                        type: 'number',
                    },
                    bnetBucketId: {
                        type: 'number',
                    },
                    bnetRecordId: {
                        type: 'number',
                    },
                }
            },
        },
    }, async (request, reply) => {
        const result = await server.conn.getCustomRepository(S2GameLobbyRepository)
            .prepareDetailedSelect()
            .andWhere('lobby.regionId = :regionId AND lobby.bnetBucketId = :bnetBucketId AND lobby.bnetRecordId = :bnetRecordId', {
                regionId: request.params.regionId,
                bnetBucketId: request.params.bnetBucketId,
                bnetRecordId: request.params.bnetRecordId,
            })
            .getOne()
        ;

        if (!result) {
            return reply.type('application/json').code(404).send();
        }

        return reply.type('application/json').send(result);
    });
});